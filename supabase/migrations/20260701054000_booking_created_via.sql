-- ============================================================================
-- VER-179 SLA dashboard §3.6 / §4.2 — SELFSVC (self-service rate) plumbing (CBSTAMP)
-- ============================================================================
-- Self-service rate needs to know who created each booking. Deriving it from
-- created_by → user_roles.role fails: RLS hides resident roles from admins and
-- roles mutate. An immutable created_via stamped at INSERT is the only correct
-- signal. This PR-A adds the column and re-states the two capacity RPCs to write
-- it. The create-booking EF classification (resident vs admin) is PR-B — auth.uid()
-- is NULL inside the service-role RPC call, so the decision must happen in the EF
-- (live user JWT) and be passed as p_created_via.
-- ============================================================================

-- 1. Column. Add with default 'legacy' so the existing 32 rows (which predate
--    channel tracking) are honestly excluded from the rate rather than mislabelled;
--    then switch the going-forward default to 'system' for any insert that doesn't
--    specify a channel. No full-table UPDATE needed.
ALTER TABLE public.booking
  ADD COLUMN created_via text NOT NULL DEFAULT 'legacy';

ALTER TABLE public.booking
  ALTER COLUMN created_via SET DEFAULT 'system';

-- ----------------------------------------------------------------------------
-- 2. create_id_booking_with_capacity_check — ranger + office-staff ID intake.
--    Same 9-arg signature (CREATE OR REPLACE preserves grants); the ONLY change is
--    created_via='ranger' on the INSERT. ID bookings are type='Illegal Dumping'
--    (excluded from SELFSVC regardless), but stamping keeps the column complete.
--    Body reproduced verbatim from prod pg_get_functiondef (2026-07-01).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_id_booking_with_capacity_check(
  p_collection_date_id uuid,
  p_collection_area_id uuid,
  p_latitude numeric,
  p_longitude numeric,
  p_geo_address text,
  p_notes text,
  p_photos text[],
  p_waste_types text[],
  p_volume text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_lock_key       bigint;
  v_client_id      uuid;
  v_contractor_id  uuid;
  v_area_code      text;
  v_pool_id        uuid;
  v_pool_date_id   uuid;
  v_pool_id_closed boolean;
  v_fy_id          uuid;
  v_service_id     uuid;
  v_id_available   integer;
  v_booking_id     uuid;
  v_ref            text;
BEGIN
  -- Rangers (field intake) and office staff (admin portal) create ID bookings.
  IF (current_user_role() IN (
    'ranger', 'contractor-admin', 'contractor-staff', 'client-admin', 'client-staff'
  )) IS NOT TRUE THEN
    RAISE EXCEPTION 'Only ranger and staff roles can create illegal dumping bookings';
  END IF;

  -- Derive tenant + area code from the area itself — never trust the caller.
  SELECT ca.client_id, ca.contractor_id, ca.code, ca.capacity_pool_id
  INTO v_client_id, v_contractor_id, v_area_code, v_pool_id
  FROM collection_area ca
  WHERE ca.id = p_collection_area_id AND ca.is_active;

  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Collection area not found';
  END IF;

  -- Enforce tenant scope.
  IF v_client_id NOT IN (SELECT accessible_client_ids()) THEN
    RAISE EXCEPTION 'Collection area is outside your accessible clients';
  END IF;

  -- Enforce sub-client scope (VER-216). NULL narrowing passes.
  IF NOT user_sub_client_allows_area(p_collection_area_id) THEN
    RAISE EXCEPTION 'Collection area is outside your sub-client scope';
  END IF;

  -- The collection date must belong to the area.
  PERFORM 1 FROM collection_date
  WHERE id = p_collection_date_id AND collection_area_id = p_collection_area_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Collection date does not belong to the collection area';
  END IF;

  -- The date must be bookable: open, not ID-closed (covers both the T-3 hard
  -- close and admin lock), and not in the past (AWST calendar date). Pooled
  -- areas additionally check the pool row's id_is_closed below.
  PERFORM 1 FROM collection_date
  WHERE id = p_collection_date_id
    AND is_open
    AND NOT id_is_closed
    AND date >= (now() AT TIME ZONE 'Australia/Perth')::date;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Collection date is closed for illegal dumping bookings';
  END IF;

  SELECT id INTO v_fy_id FROM financial_year WHERE is_current = true LIMIT 1;
  IF v_fy_id IS NULL THEN
    RAISE EXCEPTION 'No active financial year';
  END IF;

  -- Single ID service stream (PRD §4.2).
  SELECT s.id INTO v_service_id
  FROM service s
  JOIN category c ON c.id = s.category_id
  WHERE c.code = 'id' AND s.is_active
  LIMIT 1;
  IF v_service_id IS NULL THEN
    RAISE EXCEPTION 'Illegal dumping service is not configured';
  END IF;

  -- Serialise concurrent bookings: pooled areas lock + count on the pool row
  -- (same key scheme as create_booking_with_capacity_check), per-date areas
  -- on the collection_date row.
  IF v_pool_id IS NOT NULL THEN
    SELECT cdp.id INTO v_pool_date_id
    FROM collection_date_pool cdp
    JOIN collection_date cd ON cd.id = p_collection_date_id
    WHERE cdp.capacity_pool_id = v_pool_id AND cdp.date = cd.date;

    IF v_pool_date_id IS NULL THEN
      RAISE EXCEPTION 'No capacity pool date exists for this collection date';
    END IF;

    v_lock_key := ('x' || substr(v_pool_date_id::text, 1, 8))::bit(32)::bigint;
  ELSE
    v_lock_key := ('x' || substr(p_collection_date_id::text, 1, 8))::bit(32)::bigint;
  END IF;

  PERFORM pg_advisory_xact_lock(v_lock_key);

  IF v_pool_id IS NOT NULL THEN
    SELECT id_capacity_limit - id_units_booked, id_is_closed
    INTO v_id_available, v_pool_id_closed
    FROM collection_date_pool
    WHERE id = v_pool_date_id;

    IF v_pool_id_closed THEN
      RAISE EXCEPTION 'Collection date is closed for illegal dumping bookings';
    END IF;
  ELSE
    SELECT id_capacity_limit - id_units_booked
    INTO v_id_available
    FROM collection_date
    WHERE id = p_collection_date_id;
  END IF;

  IF v_id_available IS NULL THEN
    RAISE EXCEPTION 'Collection date not found';
  END IF;

  IF v_id_available < 1 THEN
    RAISE EXCEPTION 'No illegal dumping capacity remaining on this date';
  END IF;

  v_ref := generate_booking_ref(v_area_code);

  INSERT INTO booking (
    ref, type, status, collection_area_id, client_id, contractor_id, fy_id,
    latitude, longitude, geo_address, notes, photos, id_waste_types, id_volume,
    created_by, created_via
  ) VALUES (
    v_ref, 'Illegal Dumping', 'Confirmed', p_collection_area_id, v_client_id, v_contractor_id, v_fy_id,
    p_latitude, p_longitude, p_geo_address, p_notes,
    COALESCE(p_photos, '{}'), COALESCE(p_waste_types, '{}'), p_volume,
    auth.uid(), 'ranger'
  )
  RETURNING id INTO v_booking_id;

  -- One free unit; the recalc trigger on booking_item bumps id_units_booked
  -- (on collection_date_pool for pooled areas, collection_date otherwise).
  INSERT INTO booking_item (
    booking_id, service_id, collection_date_id, no_services, unit_price_cents, is_extra
  ) VALUES (
    v_booking_id, v_service_id, p_collection_date_id, 1, 0, false
  );

  RETURN jsonb_build_object('booking_id', v_booking_id, 'ref', v_ref);
END;
$function$;

-- ----------------------------------------------------------------------------
-- 3. create_booking_with_capacity_check — resident + admin-on-behalf bookings.
--    Gains a 17th param p_created_via (defaulted, so the current 16-arg EF call
--    keeps working and stamps 'system' until PR-B passes the real channel).
--    Adding a param changes the identity signature, so the old 16-arg overload
--    MUST be dropped (CREATE OR REPLACE would leave both, causing overload
--    ambiguity). DROP loses grants — restore the pre-existing set. NOTE: unlike
--    create_id / create_mud (which VER-282 narrowed to authenticated+service_role),
--    this RPC keeps its historical anon + PUBLIC exec; narrowing it is out of scope
--    for VER-179 (flagged as a follow-up). Body reproduced verbatim from prod
--    pg_get_functiondef (2026-07-01) — capacity checks + pg_advisory_xact_lock
--    unchanged; the only additions are the param and the created_via INSERT column.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_booking_with_capacity_check(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb, uuid, text, boolean, text
);

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

-- Restore the pre-existing grants lost by DROP (see note above).
GRANT EXECUTE ON FUNCTION public.create_booking_with_capacity_check(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb, uuid, text, boolean, text, text
) TO anon, authenticated, service_role;
