-- ============================================================================
-- Property eligibility gate — enforce eligible_properties.is_eligible on the
-- booking write paths (16 Bolsover St subdivision investigation, 19/08/2026).
-- ============================================================================
-- `is_eligible = false` marks parcels an admin has retired from service (e.g. a
-- pre-subdivision parent lot, or a tip-pass-in-lieu property). Until now the
-- flag's ONLY effect was greying the row in admin lists: the /book lookup,
-- create-booking EF, capacity RPCs and RLS all ignored it, so a resident could
-- resolve a retired parcel, see "Property found!" and complete a booking.
--
-- Mirrors the WS-A staged go-live gate (20260622090000) layer-for-layer:
--   1. SECURITY DEFINER helper for the RLS policy (fails closed on missing row)
--   2. create_booking_with_capacity_check — gate for EVERY direct caller
--   3. create_mud_booking_with_capacity_check — same, for the admin MUD path
--   4. booking_resident_insert RLS — closes the direct-PostgREST INSERT path
-- The create-booking EF + /book UI gates ship in the same PR (early, friendly
-- rejections; these DB layers are the durable enforcement).
--
-- Deliberately NOT gated: create_id_booking_with_capacity_check (illegal
-- dumping is an incident record, not a service entitlement — dumping on a
-- retired parcel must remain recordable) and the staff rebook INSERT policies
-- from 20260717014018 (staff-mediated rebooks of the original booking's
-- property; staff can flip the flag if a rebook target is genuinely retired).

-- ── 1. SECURITY DEFINER helper so the RLS policy reads is_eligible without
--       depending on eligible_properties' own policies. Fails closed (false)
--       when the property row is absent. Mirrors collection_area_is_active.
CREATE OR REPLACE FUNCTION public.eligible_property_is_bookable(p_property_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT COALESCE(
    (SELECT is_eligible FROM public.eligible_properties WHERE id = p_property_id),
    false
  );
$$;

GRANT EXECUTE ON FUNCTION public.eligible_property_is_bookable(uuid)
  TO anon, authenticated, service_role;

-- ── 2. Gate the residential capacity RPC so EVERY direct caller (create-booking
--       EF and any future caller) fails closed. Same 17-arg signature as
--       20260701054000 → CREATE OR REPLACE, grants preserved. Body reproduced
--       verbatim from that migration; the only deltas are the eligibility gate
--       and the search_path pin re-declared inline (CREATE OR REPLACE would
--       otherwise reset the pin applied by 20260702060000).
CREATE OR REPLACE FUNCTION public.create_booking_with_capacity_check(
  p_collection_date_id uuid,
  p_property_id uuid,
  p_contact_id uuid,
  p_collection_area_id uuid,
  p_client_id uuid,
  p_contractor_id uuid,
  p_fy_id uuid,
  p_area_code text,
  p_location text,
  p_notes text,
  p_status text,
  p_items jsonb,
  p_actor_id uuid DEFAULT NULL::uuid,
  p_type text DEFAULT 'Residential'::text,
  p_terms_accepted boolean DEFAULT false,
  p_terms_channel text DEFAULT NULL::text,
  p_created_via text DEFAULT 'system'
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pool_id         uuid;
  v_date            date;
  v_pool_date_id    uuid;
  v_lock_key        bigint;
  v_booking_id      uuid;
  v_ref             text;
  v_item            jsonb;
  v_cat_code        text;
  v_units_requested integer;
  v_bulk_requested  integer := 0;
  v_anc_requested   integer := 0;
  v_id_requested    integer := 0;
  v_bulk_available  integer;
  v_anc_available   integer;
  v_id_available    integer;
  v_terms           text;
  v_terms_version   int;
BEGIN
  IF p_actor_id IS NOT NULL THEN
    PERFORM set_config('app.audit_actor', p_actor_id::text, true);
  END IF;

  -- Staged go-live gate (WS-A / VER-269): an inactive (held-back) or non-existent
  -- area returns no row, mirroring create_id_booking_with_capacity_check.
  SELECT capacity_pool_id INTO v_pool_id
  FROM collection_area
  WHERE id = p_collection_area_id AND is_active;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Collection area % is not open for bookings', p_collection_area_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Eligibility gate: admin-retired parcels (is_eligible = false) must not
  -- accept bookings. A missing property row also fails closed.
  PERFORM 1 FROM eligible_properties
  WHERE id = p_property_id AND is_eligible;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Property is not eligible for collection bookings'
      USING ERRCODE = 'check_violation';
  END IF;

  -- T&Cs gate: when the client has terms, acceptance is mandatory. Empty/whitespace
  -- terms => skipped (data-driven rollout). Text is read server-side and snapshotted;
  -- callers supply only the boolean + channel, never the text.
  SELECT terms_markdown, terms_version INTO v_terms, v_terms_version
  FROM public.client WHERE id = p_client_id;

  IF COALESCE(v_terms ~ '\S', false) AND NOT p_terms_accepted THEN
    RAISE EXCEPTION 'Terms and Conditions must be accepted before booking'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_pool_id IS NOT NULL THEN
    SELECT cd.date INTO v_date
    FROM collection_date cd
    WHERE cd.id = p_collection_date_id;

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
    FROM collection_date_pool
    WHERE id = v_pool_date_id;
  ELSE
    SELECT bulk_capacity_limit - bulk_units_booked,
           anc_capacity_limit  - anc_units_booked,
           id_capacity_limit   - id_units_booked
    INTO v_bulk_available, v_anc_available, v_id_available
    FROM collection_date
    WHERE id = p_collection_date_id;
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

  v_ref := generate_booking_ref(p_area_code);

  INSERT INTO booking (
    ref, status, type, property_id, contact_id, collection_area_id,
    client_id, contractor_id, fy_id, location, notes,
    terms_accepted_at, terms_accepted_text, terms_version,
    terms_accepted_by, terms_accepted_channel, created_via
  ) VALUES (
    v_ref, p_status::booking_status, p_type::booking_type,
    p_property_id, p_contact_id, p_collection_area_id,
    p_client_id, p_contractor_id, p_fy_id, p_location, p_notes,
    CASE WHEN COALESCE(v_terms ~ '\S', false) THEN now()           ELSE NULL END,
    CASE WHEN COALESCE(v_terms ~ '\S', false) THEN v_terms         ELSE NULL END,
    CASE WHEN COALESCE(v_terms ~ '\S', false) THEN v_terms_version ELSE NULL END,
    CASE WHEN COALESCE(v_terms ~ '\S', false) THEN p_actor_id      ELSE NULL END,
    CASE WHEN COALESCE(v_terms ~ '\S', false) THEN p_terms_channel ELSE NULL END,
    p_created_via
  )
  RETURNING id INTO v_booking_id;

  INSERT INTO booking_item (
    booking_id, service_id, collection_date_id, no_services, unit_price_cents, is_extra
  )
  SELECT
    v_booking_id,
    (item->>'service_id')::uuid,
    p_collection_date_id,
    (item->>'no_services')::integer,
    (item->>'unit_price_cents')::integer,
    (item->>'is_extra')::boolean
  FROM jsonb_array_elements(p_items) AS item;

  RETURN jsonb_build_object(
    'booking_id', v_booking_id,
    'ref', v_ref
  );
END;
$function$;

-- ── 3. Same gate on the admin MUD path. Same 5-arg signature as 20260701055000
--       → CREATE OR REPLACE preserves the VER-282 grants (authenticated +
--       service_role, anon revoked). Body reproduced verbatim; deltas are the
--       is_eligible read + gate and the pg_temp addition to the search_path pin
--       (re-declaring what 20260702060000 applied via ALTER).
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
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_is_mud          boolean;
  v_is_eligible     boolean;
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

  -- Property must be an eligible, Registered MUD with a strata contact. Derive
  -- its area + contact server-side — never trust the caller for tenant
  -- attribution.
  SELECT ep.is_mud, ep.is_eligible, ep.mud_onboarding_status, ep.strata_contact_id,
         ep.waste_location_notes, ep.collection_area_id
  INTO v_is_mud, v_is_eligible, v_onboarding, v_contact_id, v_location, v_area_id
  FROM eligible_properties ep
  WHERE ep.id = p_property_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Property not found';
  END IF;
  IF v_is_mud IS NOT TRUE THEN
    RAISE EXCEPTION 'Property is not a MUD';
  END IF;
  IF v_is_eligible IS NOT TRUE THEN
    RAISE EXCEPTION 'Property is not eligible for collection bookings';
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

-- ── 4. Close the direct-INSERT RLS path: residents/strata may only insert a
--       booking for an eligible property. Reproduces the current policy
--       (20260623100000 — WS-A area gate + T&Cs gate) plus the new predicate.
DROP POLICY IF EXISTS booking_resident_insert ON public.booking;
CREATE POLICY booking_resident_insert ON public.booking FOR INSERT
  WITH CHECK (
    current_user_role() IN ('resident', 'strata')
    AND contact_id = current_user_contact_id()
    AND public.collection_area_is_active(collection_area_id)
    AND public.eligible_property_is_bookable(property_id)
    AND (NOT public.client_has_terms(client_id) OR terms_accepted_at IS NOT NULL)
  );
