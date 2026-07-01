-- ============================================================================
-- VER-179 §3.6 / §4.2 — CBSTAMP completeness: stamp create_mud created_via='admin'
-- ============================================================================
-- The self-service metric (SELFSVC) scopes over type IN ('Residential','MUD').
-- MUD bookings are created admin-on-behalf via the DEDICATED RPC
-- create_mud_booking_with_capacity_check (VER-282) — a THIRD booking RPC that the
-- CBSTAMP PR-A (20260701054000) did not cover, because the spec listed only
-- create_booking + create_id. Without this, MUD bookings default to
-- created_via='system'. That is functionally correct for the self-service RATE
-- (system is non-resident, same as admin), but imprecise for audit + the channel
-- column. Stamp 'admin' to match create_id's 'ranger' pattern — a MUD booking is
-- always an admin-on-behalf action.
--
-- Same 5-arg signature → CREATE OR REPLACE preserves the VER-282 grants
-- (authenticated + service_role, anon revoked); no DROP, no re-grant needed. Body
-- reproduced verbatim from prod pg_get_functiondef (2026-07-01); the ONLY change
-- is created_via='admin' on the INSERT. Ordered after 20260701054000 so the
-- booking.created_via column exists.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_mud_booking_with_capacity_check(
  p_property_id uuid,
  p_collection_date_id uuid,
  p_items jsonb,
  p_notes text DEFAULT ''::text,
  p_terms_accepted boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_mud          boolean;
  v_onboarding      text;
  v_contact_id      uuid;
  v_location        text;
  v_area_id         uuid;
  v_client_id       uuid;
  v_contractor_id   uuid;
  v_area_code       text;
  v_pool_id         uuid;
  v_fy_id           uuid;
  v_date            date;
  v_pool_date_id    uuid;
  v_lock_key        bigint;
  v_terms           text;
  v_terms_version   int;
  v_has_terms       boolean;
  v_item            jsonb;
  v_cat_code        text;
  v_units_requested integer;
  v_bulk_requested  integer := 0;
  v_anc_requested   integer := 0;
  v_id_requested    integer := 0;
  v_bulk_available  integer;
  v_anc_available   integer;
  v_id_available    integer;
  v_ref             text;
  v_booking_id      uuid;
BEGIN
  -- Office staff create MUD bookings on behalf of the strata contact. NULL-safe
  -- (a caller with no active role has current_user_role() = NULL).
  IF (current_user_role() IN (
    'contractor-admin', 'contractor-staff', 'client-admin', 'client-staff'
  )) IS NOT TRUE THEN
    RAISE EXCEPTION 'Only staff roles can create MUD bookings';
  END IF;

  -- Property must be a Registered MUD with a strata contact. Derive its area +
  -- contact server-side — never trust the caller for tenant attribution.
  SELECT ep.is_mud, ep.mud_onboarding_status, ep.strata_contact_id,
         ep.waste_location_notes, ep.collection_area_id
  INTO v_is_mud, v_onboarding, v_contact_id, v_location, v_area_id
  FROM eligible_properties ep
  WHERE ep.id = p_property_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Property not found';
  END IF;
  IF v_is_mud IS NOT TRUE THEN
    RAISE EXCEPTION 'Property is not a MUD';
  END IF;
  IF v_onboarding IS DISTINCT FROM 'Registered' THEN
    RAISE EXCEPTION 'MUD must be in Registered status to create bookings';
  END IF;
  IF v_contact_id IS NULL THEN
    RAISE EXCEPTION 'MUD has no strata contact';
  END IF;
  IF v_area_id IS NULL THEN
    RAISE EXCEPTION 'MUD has no collection area';
  END IF;

  -- Area must be active (WS-A staged go-live gate). Derive tenant + area code.
  SELECT ca.client_id, ca.contractor_id, ca.code, ca.capacity_pool_id
  INTO v_client_id, v_contractor_id, v_area_code, v_pool_id
  FROM collection_area ca
  WHERE ca.id = v_area_id AND ca.is_active;

  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Collection area is not open for bookings';
  END IF;

  -- Tenant scope: caller must have access to the area's client.
  IF v_client_id NOT IN (SELECT accessible_client_ids()) THEN
    RAISE EXCEPTION 'Collection area is outside your accessible clients';
  END IF;

  -- Sub-client scope (VER-216). NULL narrowing passes.
  IF NOT user_sub_client_allows_area(v_area_id) THEN
    RAISE EXCEPTION 'Collection area is outside your sub-client scope';
  END IF;

  SELECT id INTO v_fy_id FROM financial_year WHERE is_current = true LIMIT 1;
  IF v_fy_id IS NULL THEN
    RAISE EXCEPTION 'No active financial year';
  END IF;

  -- Collection date must belong to the area, be MUD-enabled, open, and not past
  -- (AWST calendar date).
  SELECT cd.date INTO v_date
  FROM collection_date cd
  WHERE cd.id = p_collection_date_id
    AND cd.collection_area_id = v_area_id
    AND cd.for_mud
    AND cd.is_open
    AND cd.date >= (now() AT TIME ZONE 'Australia/Perth')::date;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Collection date is not available for MUD bookings';
  END IF;

  -- T&Cs gate (mirrors create_booking_with_capacity_check). Empty/whitespace
  -- terms => skipped; text is snapshotted server-side, caller passes only the
  -- boolean.
  SELECT terms_markdown, terms_version INTO v_terms, v_terms_version
  FROM client WHERE id = v_client_id;
  v_has_terms := COALESCE(v_terms ~ '\S', false);

  IF v_has_terms AND NOT p_terms_accepted THEN
    RAISE EXCEPTION 'Terms and Conditions must be accepted before booking'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── Capacity (mirrors create_booking_with_capacity_check) ─────────────────
  IF v_pool_id IS NOT NULL THEN
    SELECT id INTO v_pool_date_id
    FROM collection_date_pool
    WHERE capacity_pool_id = v_pool_id AND date = v_date;
    IF v_pool_date_id IS NULL THEN
      RAISE EXCEPTION 'No collection_date_pool row for pool % on date %', v_pool_id, v_date;
    END IF;
    v_lock_key := ('x' || substr(v_pool_date_id::text, 1, 8))::bit(32)::bigint;
  ELSE
    v_lock_key := ('x' || substr(p_collection_date_id::text, 1, 8))::bit(32)::bigint;
  END IF;

  PERFORM pg_advisory_xact_lock(v_lock_key);

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_cat_code := v_item->>'category_code';
    v_units_requested := (v_item->>'no_services')::integer;
    CASE v_cat_code
      WHEN 'bulk' THEN v_bulk_requested := v_bulk_requested + v_units_requested;
      WHEN 'anc'  THEN v_anc_requested  := v_anc_requested  + v_units_requested;
      WHEN 'id'   THEN v_id_requested   := v_id_requested   + v_units_requested;
    END CASE;
  END LOOP;

  IF v_pool_id IS NOT NULL THEN
    SELECT bulk_capacity_limit - bulk_units_booked,
           anc_capacity_limit  - anc_units_booked,
           id_capacity_limit   - id_units_booked
    INTO v_bulk_available, v_anc_available, v_id_available
    FROM collection_date_pool WHERE id = v_pool_date_id;
  ELSE
    SELECT bulk_capacity_limit - bulk_units_booked,
           anc_capacity_limit  - anc_units_booked,
           id_capacity_limit   - id_units_booked
    INTO v_bulk_available, v_anc_available, v_id_available
    FROM collection_date WHERE id = p_collection_date_id;
  END IF;

  IF v_bulk_requested > 0 AND v_bulk_available < v_bulk_requested THEN
    RAISE EXCEPTION 'Insufficient bulk capacity on collection date';
  END IF;
  IF v_anc_requested > 0 AND v_anc_available < v_anc_requested THEN
    RAISE EXCEPTION 'Insufficient ancillary capacity on collection date';
  END IF;
  IF v_id_requested > 0 AND v_id_available < v_id_requested THEN
    RAISE EXCEPTION 'Insufficient illegal dumping capacity on collection date';
  END IF;

  v_ref := generate_booking_ref(v_area_code);

  INSERT INTO booking (
    ref, status, type, property_id, contact_id, collection_area_id,
    client_id, contractor_id, fy_id, location, notes, created_by, created_via,
    terms_accepted_at, terms_accepted_text, terms_version,
    terms_accepted_by, terms_accepted_channel
  ) VALUES (
    v_ref, 'Confirmed'::booking_status, 'MUD'::booking_type,
    p_property_id, v_contact_id, v_area_id,
    v_client_id, v_contractor_id, v_fy_id, v_location, p_notes, auth.uid(), 'admin',
    CASE WHEN v_has_terms THEN now()           ELSE NULL END,
    CASE WHEN v_has_terms THEN v_terms         ELSE NULL END,
    CASE WHEN v_has_terms THEN v_terms_version ELSE NULL END,
    CASE WHEN v_has_terms THEN auth.uid()      ELSE NULL END,
    CASE WHEN v_has_terms THEN 'mud_admin'     ELSE NULL END
  )
  RETURNING id INTO v_booking_id;

  -- MUD units are always free + not extra (placeholders for the closeout).
  INSERT INTO booking_item (
    booking_id, service_id, collection_date_id, no_services, unit_price_cents, is_extra
  )
  SELECT
    v_booking_id,
    (item->>'service_id')::uuid,
    p_collection_date_id,
    (item->>'no_services')::integer,
    0,
    false
  FROM jsonb_array_elements(p_items) AS item;

  RETURN jsonb_build_object('booking_id', v_booking_id, 'ref', v_ref);
END;
$function$;
