-- Council staff may book an illegal-dumping collection inside the 3-day window.
--
-- WMRC asked for this before the 01/10/2026 Verge Valet cutover: council and
-- WMRC staff need to place an ID collection within the T-3 period "if spots are
-- available". Today only contractor-admin can book a closed date (migration
-- 20260703040000), so council staff hit a dead end and have to ring the office.
--
-- What changes: contractor-staff, client-admin and client-staff may now book a
-- date that the T-3 lock closed, PROVIDED it is otherwise open and still has ID
-- capacity. What does NOT change:
--   * The capacity ceiling. id_units_booked >= id_capacity_limit is still
--     refused, for every role, under the same advisory lock.
--   * Public holidays and admin-closed dates (is_open = false) stay shut for
--     these roles — no crew runs, so a booking there would strand. Only
--     contractor-admin keeps that override.
--   * Past dates, tenant scope, sub-client scope, ranger's open-dates-only gate.
--
-- Why the gate reads `locked_closed` and not just `id_is_closed`:
-- `id_is_closed` is `locked_closed OR (id_units_booked >= id_capacity_limit)`
-- (migration 20260518005937), so it cannot tell "locked" from "full" on its own.
-- `NOT id_is_closed OR locked_closed` admits the locked case and leaves the full
-- case to the capacity check below. The pooled branch mirrors it on
-- collection_date_pool, which carries the same two columns.
--
-- Mirror: src/lib/booking/id-date-access.ts keeps the admin date picker showing
-- exactly the dates this function accepts. Change both together.
--
-- Signature is unchanged, so generated types are unaffected.

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
  v_lock_key            bigint;
  v_client_id           uuid;
  v_contractor_id       uuid;
  v_area_code           text;
  v_pool_id             uuid;
  v_pool_date_id        uuid;
  v_pool_id_closed      boolean;
  v_fy_id               uuid;
  v_service_id          uuid;
  v_id_available        integer;
  v_booking_id          uuid;
  v_ref                 text;
  v_is_contractor_admin boolean;
  v_may_book_locked     boolean;
  v_pool_locked         boolean;
  v_contact_id          uuid;
BEGIN
  -- Rangers (field intake) and office staff (admin portal) create ID bookings.
  IF (current_user_role() IN (
    'ranger', 'contractor-admin', 'contractor-staff', 'client-admin', 'client-staff'
  )) IS NOT TRUE THEN
    RAISE EXCEPTION 'Only ranger and staff roles can create illegal dumping bookings';
  END IF;

  -- Contractor-admins may book closed-but-not-full dates (capacity still holds).
  v_is_contractor_admin := current_user_role() = 'contractor-admin';

  -- Office + council staff may book a date the T-3 lock closed, as long as it
  -- is otherwise open and not full (WMRC 3-day ask). Rangers are excluded.
  v_may_book_locked := current_user_role() IN (
    'contractor-staff', 'client-admin', 'client-staff'
  );

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

  -- Date validity. Every role: not in the past (AWST calendar date). Standard
  -- roles additionally require the date to be open and not ID-closed (covers
  -- the T-3 hard close and admin lock). Contractor-admins skip the closure
  -- checks — capacity below still gates them — so they can schedule onto a
  -- closed date that still has room.
  IF v_is_contractor_admin THEN
    PERFORM 1 FROM collection_date
    WHERE id = p_collection_date_id
      AND date >= (now() AT TIME ZONE 'Australia/Perth')::date;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Collection date is in the past';
    END IF;
  ELSIF v_may_book_locked THEN
    -- Open, not in the past, and closed only by the T-3 lock (if at all).
    -- A full date passes here and is refused by the capacity check below.
    PERFORM 1 FROM collection_date
    WHERE id = p_collection_date_id
      AND is_open
      AND (NOT id_is_closed OR locked_closed)
      AND date >= (now() AT TIME ZONE 'Australia/Perth')::date;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Collection date is closed for illegal dumping bookings';
    END IF;
  ELSE
    PERFORM 1 FROM collection_date
    WHERE id = p_collection_date_id
      AND is_open
      AND NOT id_is_closed
      AND date >= (now() AT TIME ZONE 'Australia/Perth')::date;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Collection date is closed for illegal dumping bookings';
    END IF;
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
    SELECT id_capacity_limit - id_units_booked, id_is_closed, locked_closed
    INTO v_id_available, v_pool_id_closed, v_pool_locked
    FROM collection_date_pool
    WHERE id = v_pool_date_id;

    -- Same three tiers as the per-date gate above: contractor-admin overrides
    -- any closure, office/council staff override a lock-only closure, everyone
    -- else is refused. Capacity below still stops a full pool date.
    IF v_pool_id_closed
       AND NOT v_is_contractor_admin
       AND NOT (v_may_book_locked AND v_pool_locked) THEN
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

  -- Link the logging user's own contact (staff all have one; ranger without a
  -- linked contact → NULL, unchanged). Shows who logged the collection in the
  -- booking detail. No notifications result — dispatch skips Illegal Dumping.
  v_contact_id := COALESCE(current_user_contact_id(), current_user_contact_id_by_email());

  INSERT INTO booking (
    ref, type, status, collection_area_id, client_id, contractor_id, fy_id,
    latitude, longitude, geo_address, notes, photos, id_waste_types, id_volume,
    created_by, contact_id
  ) VALUES (
    v_ref, 'Illegal Dumping', 'Confirmed', p_collection_area_id, v_client_id, v_contractor_id, v_fy_id,
    p_latitude, p_longitude, p_geo_address, p_notes,
    COALESCE(p_photos, '{}'), COALESCE(p_waste_types, '{}'), p_volume,
    auth.uid(), v_contact_id
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
