-- Atomic Illegal Dumping booking creation.
--
-- Models create_booking_with_capacity_check (advisory lock + capacity check +
-- insert) but for the ranger ID flow, which differs in three ways:
--   1. No property/contact, no pricing — geo-only, internally charged.
--   2. Lands directly in 'Confirmed' so the daily transition-scheduled cron
--      promotes it to 'Scheduled' onto the run sheet (the previous code left it
--      in 'Submitted', which no cron ever advances).
--   3. SECURITY DEFINER: there is no booking/booking_item INSERT RLS policy for
--      the ranger role (only residents can self-insert), and the ranger server
--      action runs with the anon key + user JWT, never the service role. So the
--      insert must run as the function owner, with the role + tenant checks
--      enforced explicitly below.
--
-- Tenant fields (client, contractor, area code) are derived from the area, never
-- trusted from the caller. Capacity is read from the per-date counters to match
-- create_booking_with_capacity_check; pooled-date aggregation is out of scope.

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
  v_lock_key      bigint;
  v_client_id     uuid;
  v_contractor_id uuid;
  v_area_code     text;
  v_fy_id         uuid;
  v_service_id    uuid;
  v_id_available  integer;
  v_booking_id    uuid;
  v_ref           text;
BEGIN
  -- Only rangers create ID bookings (PRD §2.2).
  IF current_user_role() <> 'ranger' THEN
    RAISE EXCEPTION 'Only the ranger role can create illegal dumping bookings';
  END IF;

  -- Derive tenant + area code from the area itself — never trust the caller.
  SELECT ca.client_id, ca.contractor_id, ca.code
  INTO v_client_id, v_contractor_id, v_area_code
  FROM collection_area ca
  WHERE ca.id = p_collection_area_id;

  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Collection area not found';
  END IF;

  -- Enforce ranger tenant scope.
  IF v_client_id NOT IN (SELECT accessible_client_ids()) THEN
    RAISE EXCEPTION 'Collection area is outside your accessible clients';
  END IF;

  -- The collection date must belong to the area.
  PERFORM 1 FROM collection_date
  WHERE id = p_collection_date_id AND collection_area_id = p_collection_area_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Collection date does not belong to the collection area';
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

  -- Serialise concurrent bookings on this date (same key scheme as residential).
  v_lock_key := ('x' || substr(p_collection_date_id::text, 1, 8))::bit(32)::bigint;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT id_capacity_limit - id_units_booked
  INTO v_id_available
  FROM collection_date
  WHERE id = p_collection_date_id;

  IF v_id_available IS NULL THEN
    RAISE EXCEPTION 'Collection date not found';
  END IF;

  IF v_id_available < 1 THEN
    RAISE EXCEPTION 'No illegal dumping capacity remaining on this date';
  END IF;

  v_ref := generate_booking_ref(v_area_code);

  INSERT INTO booking (
    ref, type, status, collection_area_id, client_id, contractor_id, fy_id,
    latitude, longitude, geo_address, notes, photos, id_waste_types, id_volume
  ) VALUES (
    v_ref, 'Illegal Dumping', 'Confirmed', p_collection_area_id, v_client_id, v_contractor_id, v_fy_id,
    p_latitude, p_longitude, p_geo_address, p_notes,
    COALESCE(p_photos, '{}'), COALESCE(p_waste_types, '{}'), p_volume
  )
  RETURNING id INTO v_booking_id;

  -- One free unit; the recalc trigger on booking_item bumps id_units_booked.
  INSERT INTO booking_item (
    booking_id, service_id, collection_date_id, no_services, unit_price_cents, is_extra
  ) VALUES (
    v_booking_id, v_service_id, p_collection_date_id, 1, 0, false
  );

  RETURN jsonb_build_object('booking_id', v_booking_id, 'ref', v_ref);
END;
$$;
