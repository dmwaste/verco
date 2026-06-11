-- Admin ID request form — widen create_id_booking_with_capacity_check to
-- office staff, and harden the RPC while its audience grows.
--
-- Rangers raise IDs from the field; office staff now also log phoned-in
-- reports from the admin portal. The role gate widens from ranger-only to
-- ranger + the four staff roles. `field` stays excluded (PRD §2.2), as do
-- resident/strata.
--
-- Hardening added in the same restatement (review findings):
--   1. NULL-safe role gate — current_user_role() is NULL for a caller with no
--      active user_roles row, and NULL NOT IN (...) is NULL → a bare IF would
--      silently let role-less callers past the gate.
--   2. user_sub_client_allows_area() (VER-216): a client-tier user narrowed
--      to one sub-client cannot book an ID into another sub-client's area.
--      NULL narrowing (full-client scope, contractor users) passes unchanged.
--   3. Inactive areas rejected (the forms filter is_active app-side only).
--   4. Date-validity: the forms filter to open/unclosed/future dates, but the
--      RPC is directly callable via PostgREST by any permitted role — without
--      these checks a direct call could land a Confirmed booking on a closed
--      or past date (past dates get flipped to Scheduled by the 15:25 cron
--      but never picked up by the OptimoRoute push → zombie Scheduled).
--   5. Pool-aware capacity (was pool-blind since 20260525000300): for areas
--      with capacity_pool_id (VV/WMRC), ID counters live on
--      collection_date_pool — the recalc trigger's pooled branch updates ONLY
--      the pool row, so checking collection_date counters both fails to
--      enforce and never serialises against other pooled bookings. Mirror
--      create_booking_with_capacity_check: lock + check the pool row.
--
-- Signature identical to 20260610010300, so generated types are unaffected.
CREATE OR REPLACE FUNCTION create_id_booking_with_capacity_check(
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
SET search_path = public
AS $$
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
    created_by
  ) VALUES (
    v_ref, 'Illegal Dumping', 'Confirmed', p_collection_area_id, v_client_id, v_contractor_id, v_fy_id,
    p_latitude, p_longitude, p_geo_address, p_notes,
    COALESCE(p_photos, '{}'), COALESCE(p_waste_types, '{}'), p_volume,
    auth.uid()
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
$$;
