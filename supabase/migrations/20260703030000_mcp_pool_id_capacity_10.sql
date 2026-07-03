-- MCP capacity pool — add 10 shared illegal-dumping (ID) slots per collection date.
--
-- Context: the four pooled Verge Valet suburbs (MOS, COT, PEP, FRE-N) share the
-- `MCP` capacity pool. Pooled areas keep their real counters on
-- collection_date_pool; the per-area collection_date.* columns stay at 0 by
-- design. ID capacity was never seeded — capacity_pool_schedule only set
-- bulk_capacity_limit=60 (Mon+Wed), so id_capacity_limit defaulted to 0 and the
-- generate-collection-dates cron copied that 0 onto every collection_date_pool
-- row. Two symptoms:
--   * create_id_booking_with_capacity_check rejects every pooled ID booking; and
--   * the admin ID column shows "Closed" on active dates — the recalc trigger
--     computes id_is_closed = (0 >= 0) = true once any bulk booking fires it.
--
-- This migration (data-only, no schema change, no type regen):
--   1. Persists id_capacity_limit=10 on the MCP pool schedule (Mon+Wed) so all
--      future generate-collection-dates runs emit 10.
--   2. Backfills existing future collection_date_pool rows to id_capacity_limit=10,
--      recomputing id_is_closed exactly as the recalc trigger does
--      (locked_closed OR units>=limit). Public holidays are excluded (they stay
--      cap 0 / closed) and the sticky T-3 hard-close (locked_closed) is preserved.
--
-- The 10 slots are SHARED across the four suburbs per date (pool semantics),
-- not 10 per suburb.

-- 1. Persistent — future generated dates (schedule template the nightly
--    generate-collection-dates Edge Function reads).
UPDATE capacity_pool_schedule cps
SET id_capacity_limit = 10, updated_at = now()
FROM capacity_pool cp
JOIN contractor c ON c.id = cp.contractor_id
WHERE cps.capacity_pool_id = cp.id
  AND cp.code = 'MCP' AND c.slug = 'dmwm'
  AND cps.day_of_week IN (1, 3);   -- Mon + Wed

-- 2. Backfill — existing future pool dates. The generator upserts with
--    ON CONFLICT DO NOTHING, so step 1 alone never revisits already-generated
--    rows. AWST date matches the close-imminent cron's cutoff semantics.
UPDATE collection_date_pool cdp
SET id_capacity_limit = 10,
    id_is_closed = cdp.locked_closed OR (cdp.id_units_booked >= 10),
    updated_at = now()
FROM capacity_pool cp
JOIN contractor c ON c.id = cp.contractor_id
WHERE cdp.capacity_pool_id = cp.id
  AND cp.code = 'MCP' AND c.slug = 'dmwm'
  AND cdp.date >= (now() AT TIME ZONE 'Australia/Perth')::date
  AND NOT EXISTS (
    SELECT 1 FROM public_holiday ph
    WHERE ph.date = cdp.date AND ph.jurisdiction = 'WA'
  );

-- 3. Guard: fail loudly if the pool identity drifted (code/slug rename) so the
--    migration can't silently no-op. Report how many future dates were backfilled.
DO $$
DECLARE
  v_schedule_rows integer;
  v_backfilled    integer;
BEGIN
  SELECT COUNT(*) INTO v_schedule_rows
  FROM capacity_pool_schedule cps
  JOIN capacity_pool cp ON cp.id = cps.capacity_pool_id
  JOIN contractor c ON c.id = cp.contractor_id
  WHERE cp.code = 'MCP' AND c.slug = 'dmwm'
    AND cps.day_of_week IN (1, 3)
    AND cps.id_capacity_limit = 10;

  IF v_schedule_rows <> 2 THEN
    RAISE EXCEPTION 'Expected 2 MCP pool schedule rows at id_capacity_limit=10, got %', v_schedule_rows;
  END IF;

  SELECT COUNT(*) INTO v_backfilled
  FROM collection_date_pool cdp
  JOIN capacity_pool cp ON cp.id = cdp.capacity_pool_id
  JOIN contractor c ON c.id = cp.contractor_id
  WHERE cp.code = 'MCP' AND c.slug = 'dmwm'
    AND cdp.date >= (now() AT TIME ZONE 'Australia/Perth')::date
    AND cdp.id_capacity_limit = 10;

  RAISE NOTICE 'MCP pool ID capacity: schedule set to 10 (Mon+Wed); % future pool dates now at id_capacity_limit=10', v_backfilled;
END $$;
