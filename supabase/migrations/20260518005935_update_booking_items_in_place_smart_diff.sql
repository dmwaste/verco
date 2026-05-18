-- VER-208: smart booking_item diff during in-place edit.
--
-- The previous version did `DELETE FROM booking_item WHERE booking_id = X`
-- + re-INSERT of every item, which fired the audit_trigger on every row
-- regardless of whether the item actually changed. Audit timelines for
-- routine edits showed phantom "Service item deleted: General × 1" +
-- "Service item created: General × 1" pairs for items that were never
-- touched, drowning out the real change.
--
-- This rewrite matches each new item to an existing row by its "essence"
-- (service_id, is_extra, unit_price_cents) and produces only the audit
-- entries that reflect a real change:
--
--   * essence in BOTH old & new, qty + date unchanged → no op, no audit
--   * essence in BOTH, qty or date differs            → UPDATE the row
--   * essence only in OLD                             → DELETE
--   * essence only in NEW                             → INSERT
--
-- Capacity check runs against the delta (new_total − existing_total per
-- category) so a no-op edit doesn't need any capacity headroom, and a
-- reduction always passes regardless of how full the date is.
--
-- The companion migration 20260518005934_recalc_units_handles_date_change
-- ensures that an UPDATE which only swaps collection_date_id refunds the
-- OLD date and charges the NEW date — without that fix the smart-diff
-- date-only case would silently leave the old date over-counted.

CREATE OR REPLACE FUNCTION update_booking_items_in_place(
  p_booking_id         uuid,
  p_collection_date_id uuid,
  p_items              jsonb,
  p_actor_id           uuid DEFAULT NULL,
  p_location           text DEFAULT NULL,
  p_notes              text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_booking         booking%ROWTYPE;
  v_pool_id         uuid;
  v_date            date;
  v_pool_date_id    uuid;
  v_lock_key        bigint;
  v_existing_bulk   integer;
  v_existing_anc    integer;
  v_existing_id     integer;
  v_new_bulk        integer;
  v_new_anc         integer;
  v_new_id          integer;
  v_bulk_available  integer;
  v_anc_available   integer;
  v_id_available    integer;
  v_bulk_delta      integer;
  v_anc_delta       integer;
  v_id_delta        integer;
BEGIN
  IF p_actor_id IS NOT NULL THEN
    PERFORM set_config('app.audit_actor', p_actor_id::text, true);
  END IF;

  SELECT * INTO v_booking FROM booking WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found: %', p_booking_id;
  END IF;

  SELECT capacity_pool_id INTO v_pool_id
  FROM collection_area WHERE id = v_booking.collection_area_id;

  IF v_pool_id IS NOT NULL THEN
    SELECT cd.date INTO v_date FROM collection_date cd WHERE cd.id = p_collection_date_id;
    SELECT id INTO v_pool_date_id FROM collection_date_pool
      WHERE capacity_pool_id = v_pool_id AND date = v_date;
    IF v_pool_date_id IS NULL THEN
      RAISE EXCEPTION 'No collection_date_pool row for pool % on date %', v_pool_id, v_date;
    END IF;
    v_lock_key := ('x' || substr(v_pool_date_id::text, 1, 8))::bit(32)::bigint;
  ELSE
    v_lock_key := ('x' || substr(p_collection_date_id::text, 1, 8))::bit(32)::bigint;
  END IF;

  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Materialise the incoming items into a temp table for repeated diff
  -- queries below. ON COMMIT DROP cleans up at end of the transaction.
  CREATE TEMP TABLE _new_items (
    service_id        uuid    NOT NULL,
    no_services       integer NOT NULL,
    unit_price_cents  integer NOT NULL,
    is_extra          boolean NOT NULL,
    category_code     text    NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO _new_items (service_id, no_services, unit_price_cents, is_extra, category_code)
  SELECT
    (item->>'service_id')::uuid,
    (item->>'no_services')::integer,
    (item->>'unit_price_cents')::integer,
    (item->>'is_extra')::boolean,
    item->>'category_code'
  FROM jsonb_array_elements(p_items) AS item;

  -- Existing per-category totals (before any mutation).
  SELECT
    COALESCE(SUM(CASE WHEN c.code = 'bulk' THEN bi.no_services END), 0),
    COALESCE(SUM(CASE WHEN c.code = 'anc'  THEN bi.no_services END), 0),
    COALESCE(SUM(CASE WHEN c.code = 'id'   THEN bi.no_services END), 0)
  INTO v_existing_bulk, v_existing_anc, v_existing_id
  FROM booking_item bi
  JOIN service s ON s.id = bi.service_id
  JOIN category c ON c.id = s.category_id
  WHERE bi.booking_id = p_booking_id;

  -- Requested per-category totals.
  SELECT
    COALESCE(SUM(CASE WHEN category_code = 'bulk' THEN no_services END), 0),
    COALESCE(SUM(CASE WHEN category_code = 'anc'  THEN no_services END), 0),
    COALESCE(SUM(CASE WHEN category_code = 'id'   THEN no_services END), 0)
  INTO v_new_bulk, v_new_anc, v_new_id
  FROM _new_items;

  -- Capacity available right now (i.e. with existing items currently charged).
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

  -- Check delta only — reductions always pass; equal-totals no-op passes.
  v_bulk_delta := v_new_bulk - v_existing_bulk;
  v_anc_delta  := v_new_anc  - v_existing_anc;
  v_id_delta   := v_new_id   - v_existing_id;

  IF v_bulk_delta > 0 AND v_bulk_delta > v_bulk_available THEN
    RAISE EXCEPTION 'Insufficient bulk capacity on collection date';
  END IF;
  IF v_anc_delta > 0 AND v_anc_delta > v_anc_available THEN
    RAISE EXCEPTION 'Insufficient ancillary capacity on collection date';
  END IF;
  IF v_id_delta > 0 AND v_id_delta > v_id_available THEN
    RAISE EXCEPTION 'Insufficient illegal dumping capacity on collection date';
  END IF;

  -- DELETE: existing rows whose essence has no match in the new set.
  -- The audit trigger fires once per deleted row → exactly one
  -- "Service item deleted" entry per genuinely-removed item.
  DELETE FROM booking_item bi
  WHERE bi.booking_id = p_booking_id
  AND NOT EXISTS (
    SELECT 1 FROM _new_items ni
    WHERE ni.service_id        = bi.service_id
    AND   ni.is_extra          = bi.is_extra
    AND   ni.unit_price_cents  = bi.unit_price_cents
  );

  -- UPDATE: rows whose essence matches but no_services or
  -- collection_date_id differ. The audit trigger fires once per UPDATEd
  -- row → "Service item: no_services updated" / "Collection date updated"
  -- entries that name the actual change. The IS DISTINCT FROM guard
  -- ensures truly unchanged rows are not touched.
  UPDATE booking_item bi
  SET
    no_services        = ni.no_services,
    collection_date_id = p_collection_date_id
  FROM _new_items ni
  WHERE bi.booking_id        = p_booking_id
  AND   bi.service_id        = ni.service_id
  AND   bi.is_extra          = ni.is_extra
  AND   bi.unit_price_cents  = ni.unit_price_cents
  AND ( bi.no_services        IS DISTINCT FROM ni.no_services
     OR bi.collection_date_id IS DISTINCT FROM p_collection_date_id);

  -- INSERT: new items whose essence has no match in existing.
  INSERT INTO booking_item
    (booking_id, service_id, collection_date_id, no_services, unit_price_cents, is_extra)
  SELECT p_booking_id, ni.service_id, p_collection_date_id, ni.no_services, ni.unit_price_cents, ni.is_extra
  FROM _new_items ni
  WHERE NOT EXISTS (
    SELECT 1 FROM booking_item bi
    WHERE bi.booking_id        = p_booking_id
    AND   bi.service_id        = ni.service_id
    AND   bi.is_extra          = ni.is_extra
    AND   bi.unit_price_cents  = ni.unit_price_cents
  );

  -- Booking-level fields only when they actually changed (per the
  -- 20260515064221 fix — preserved).
  IF (p_location IS NOT NULL AND p_location IS DISTINCT FROM v_booking.location)
     OR (p_notes IS NOT NULL AND p_notes IS DISTINCT FROM v_booking.notes) THEN
    UPDATE booking
       SET location = COALESCE(p_location, location),
           notes    = COALESCE(p_notes, notes)
     WHERE id = p_booking_id;
  END IF;

  RETURN jsonb_build_object('booking_id', p_booking_id, 'ref', v_booking.ref);
END;
$$;
