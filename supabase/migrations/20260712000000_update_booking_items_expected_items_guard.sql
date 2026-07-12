-- #387.1 — concurrency guard on update_booking_items_in_place.
--
-- The create-booking EF's inline-quantity-edit path computes the refund delta
-- from a baseline it reads BEFORE this RPC takes its lock. The RPC's existing
-- `booking … FOR UPDATE` + advisory lock serialise the WRITES, but each call
-- still applies its own p_items against that pre-lock baseline — so two
-- concurrent edits of one booking both price a refund against the same original
-- items and BOTH refunds fire (a double-refund; the final item state reflects
-- only the last writer). The idempotency keys added in #391 stop a *retry* from
-- double-paying, but not two genuinely-simultaneous *different* edits.
--
-- Fix: add an optional `p_expected_items` (the service_id → no_services set the
-- caller priced against). Under the lock, verify the CURRENT persisted items
-- still match it; abort if not, so the caller re-prices from fresh state instead
-- of applying a stale-baseline refund. NULL (the wizard edit path, which never
-- computes a refund) skips the check — behaviour there is unchanged.
--
-- Signature change (6 → 7 args) can't go through CREATE OR REPLACE, so DROP +
-- CREATE. The new 7th arg defaults NULL, so the currently-deployed EF's 6-arg
-- call still resolves during the migration→EF-deploy window (precondition
-- skipped). Body is otherwise functionally identical to the live prod
-- definition (explanatory comments elided — don't treat a prod-vs-repo byte
-- diff of this function as drift).

DROP FUNCTION IF EXISTS public.update_booking_items_in_place(uuid, uuid, jsonb, uuid, text, text);

CREATE FUNCTION public.update_booking_items_in_place(
  p_booking_id uuid,
  p_collection_date_id uuid,
  p_items jsonb,
  p_actor_id uuid DEFAULT NULL::uuid,
  p_location text DEFAULT NULL::text,
  p_notes text DEFAULT NULL::text,
  p_expected_items jsonb DEFAULT NULL::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- #387.1 concurrency precondition. Verify the booking's CURRENT items (under
  -- the lock) still match the set the caller priced its refund against. A
  -- mismatch means a concurrent edit landed since the caller read its baseline,
  -- so its refund would be wrong — abort and let it re-price. Compared as
  -- service_id → summed no_services (order-independent); NULL skips the check.
  IF p_expected_items IS NOT NULL THEN
    -- Status re-check under the lock: the EF gates on Confirmed BEFORE this
    -- transaction, and a concurrent cancel changes status but not items, so the
    -- items comparison below would pass. Without this, an inline edit racing a
    -- cancel rewrites items on a Cancelled booking and raises a delta refund on
    -- top of the cancel's full-amount one. Message carries the EF's
    -- concurrent-edit marker so it maps to the retryable 409.
    IF v_booking.status <> 'Confirmed' THEN
      RAISE EXCEPTION 'Booking status changed since this edit was priced (concurrent edit) — reload and try again';
    END IF;

    IF EXISTS (
      WITH cur AS (
        SELECT service_id, SUM(no_services)::int AS qty
        FROM booking_item WHERE booking_id = p_booking_id
        GROUP BY service_id
      ),
      exp AS (
        SELECT (e->>'service_id')::uuid AS service_id, SUM((e->>'no_services')::int)::int AS qty
        FROM jsonb_array_elements(p_expected_items) AS e
        GROUP BY (e->>'service_id')::uuid
      )
      SELECT 1
      FROM cur FULL OUTER JOIN exp USING (service_id)
      WHERE COALESCE(cur.qty, 0) IS DISTINCT FROM COALESCE(exp.qty, 0)
    ) THEN
      RAISE EXCEPTION 'Booking items changed since this edit was priced (concurrent edit) — reload and try again';
    END IF;

    -- Date pin: a concurrent date change (updateCollectionDetails) moves
    -- booking_item.collection_date_id without changing quantities, so it passes
    -- the items comparison — but applying this edit would silently snap every
    -- item back to the stale date it was priced against (and shuffle capacity
    -- counters with it). Abort so the caller re-reads. Same marker message.
    IF EXISTS (
      SELECT 1 FROM booking_item
      WHERE booking_id = p_booking_id
        AND collection_date_id IS DISTINCT FROM p_collection_date_id
    ) THEN
      RAISE EXCEPTION 'Booking date changed since this edit was priced (concurrent edit) — reload and try again';
    END IF;
  END IF;

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

  SELECT
    COALESCE(SUM(CASE WHEN c.code = 'bulk' THEN bi.no_services END), 0),
    COALESCE(SUM(CASE WHEN c.code = 'anc'  THEN bi.no_services END), 0),
    COALESCE(SUM(CASE WHEN c.code = 'id'   THEN bi.no_services END), 0)
  INTO v_existing_bulk, v_existing_anc, v_existing_id
  FROM booking_item bi
  JOIN service s ON s.id = bi.service_id
  JOIN category c ON c.id = s.category_id
  WHERE bi.booking_id = p_booking_id;

  SELECT
    COALESCE(SUM(CASE WHEN category_code = 'bulk' THEN no_services END), 0),
    COALESCE(SUM(CASE WHEN category_code = 'anc'  THEN no_services END), 0),
    COALESCE(SUM(CASE WHEN category_code = 'id'   THEN no_services END), 0)
  INTO v_new_bulk, v_new_anc, v_new_id
  FROM _new_items;

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

  DELETE FROM booking_item bi
  WHERE bi.booking_id = p_booking_id
  AND NOT EXISTS (
    SELECT 1 FROM _new_items ni
    WHERE ni.service_id        = bi.service_id
    AND   ni.is_extra          = bi.is_extra
    AND   ni.unit_price_cents  = bi.unit_price_cents
  );

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

  IF (p_location IS NOT NULL AND p_location IS DISTINCT FROM v_booking.location)
     OR (p_notes IS NOT NULL AND p_notes IS DISTINCT FROM v_booking.notes) THEN
    UPDATE booking
       SET location = COALESCE(p_location, location),
           notes    = COALESCE(p_notes, notes)
     WHERE id = p_booking_id;
  END IF;

  RETURN jsonb_build_object('booking_id', p_booking_id, 'ref', v_booking.ref);
END;
$function$;

-- Preserve the prior grant set (PUBLIC EXECUTE was default; these are explicit
-- mirrors of the observed prod ACL). SECURITY INVOKER — RLS still applies to the
-- caller, matching the pre-existing function.
GRANT EXECUTE ON FUNCTION public.update_booking_items_in_place(uuid, uuid, jsonb, uuid, text, text, jsonb)
  TO anon, authenticated, service_role;
