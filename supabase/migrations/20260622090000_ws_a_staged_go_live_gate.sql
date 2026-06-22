-- WS-A / VER-269 — staged go-live gate.
--
-- Only collection areas with is_active = true are bookable on the new system.
-- The resident /book flow (client UX) and the create-booking Edge Function (403)
-- already gate, but the adversarial review found two server-side write paths that
-- bypassed the EF:
--   1. createMudBooking calls create_booking_with_capacity_check directly.
--   2. booking_resident_insert RLS permitted a direct PostgREST INSERT.
-- This migration closes both at the durable layer, mirroring the already-hardened
-- create_id_booking_with_capacity_check (`WHERE ca.id = ... AND ca.is_active`).

-- 1. SECURITY DEFINER helper so the RLS policy can read is_active without
--    recursing through collection_area's own policies. Fails closed (false) when
--    the area is absent.
CREATE OR REPLACE FUNCTION public.collection_area_is_active(p_area_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT COALESCE(
    (SELECT is_active FROM public.collection_area WHERE id = p_area_id),
    false
  );
$$;

GRANT EXECUTE ON FUNCTION public.collection_area_is_active(uuid)
  TO anon, authenticated, service_role;

-- 2. Gate the residential/MUD capacity RPC so EVERY direct caller (create-booking
--    EF, createMudBooking, and any future caller) fails closed. Filtering the
--    area lookup by is_active means an inactive (held-back) or non-existent area
--    returns no row. Signature unchanged, so CREATE OR REPLACE (no DROP).
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
  p_actor_id uuid DEFAULT NULL,
  p_type text DEFAULT 'Residential'
) RETURNS jsonb
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
    client_id, contractor_id, fy_id, location, notes
  ) VALUES (
    v_ref, p_status::booking_status, p_type::booking_type,
    p_property_id, p_contact_id, p_collection_area_id,
    p_client_id, p_contractor_id, p_fy_id, p_location, p_notes
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

-- 3. Close the direct-INSERT RLS path: residents/strata may only insert into an
--    active area. The RPC path is unaffected for active areas (helper returns true).
DROP POLICY IF EXISTS booking_resident_insert ON public.booking;
CREATE POLICY booking_resident_insert ON public.booking FOR INSERT
  WITH CHECK (
    current_user_role() IN ('resident', 'strata')
    AND contact_id = current_user_contact_id()
    AND public.collection_area_is_active(collection_area_id)
  );
