-- Reduce City of Kwinana Illegal-Dumping (ID) capacity to 2 units per collection day.
--
-- Why this exists
-- ----------------
-- Ops asked to cap Kwinana ID collections at 2 per collection day (was 10).
-- The ID daily cap for an UNPOOLED area (all four KWN zones are unpooled —
-- capacity_pool_id IS NULL) lives in TWO places, and both must move together
-- or the change silently reverts:
--
--   1. collection_schedule.id_capacity_limit — the per-area/per-weekday template
--      the generate-collection-dates cron copies into every NEW collection_date
--      row (16-week horizon). Seeded to 10 in 20260703085526. Left at 10, the
--      cron would keep minting fresh KWN dates at 10.
--
--   2. collection_date.id_capacity_limit — the value on each already-generated
--      date. The seed migration deliberately does NOT retro-alter these, so the
--      88 open future KWN dates still sit at 10 until updated here.
--
-- Scope
-- -----
--   * Schedule: all four KWN zones -> 2 (go-forward generation).
--   * Existing dates: FUTURE (date >= current_date at apply time) rows only, and
--     only where id_capacity_limit > 2. This intentionally SKIPS:
--       - past dates (already collected — their caps are irrelevant), and
--       - any future date deliberately closed at id_capacity_limit = 0 (1 such
--         date on prod at time of writing — 0 is already <= 2; raising it to 2
--         would re-open an intentional closure).
--   * id_is_closed is recomputed for the touched rows: a date whose id_units_booked
--     already >= 2 correctly becomes full. On prod at time of writing exactly one
--     future date has 2 ID units booked, so it (correctly) closes; no date is
--     over-booked relative to the new cap of 2.
--
-- Idempotent: both UPDATEs are predicated on the value not already being final
-- (schedule: id_capacity_limit <> 2; dates: id_capacity_limit > 2), so a re-run
-- touches nothing. Supersedes the id_capacity_limit = 10 set by 20260703085526
-- for KWN by running later (later migration wins).
--
-- Reset-safe: the KWN client + areas are NOT created by any migration (they were
-- inserted into prod manually — see scripts/import-kwn-properties.ts — and into
-- the local/E2E stack by supabase/seed.sql, which runs AFTER migrations). On a
-- fresh `supabase db reset` this migration finds zero KWN rows and is a harmless
-- no-op. The sanity check below asserts the INVARIANT (no KWN row left above 2),
-- which holds both on prod (rows updated) and on a fresh reset (no rows at all).

-- 1. Go-forward template: KWN schedule rows -> 2.
UPDATE collection_schedule cs
SET id_capacity_limit = 2,
    updated_at        = now()
FROM collection_area ca
WHERE ca.id = cs.collection_area_id
  AND ca.client_id = (SELECT id FROM client WHERE slug = 'kwn')
  AND ca.code IN ('KWN-1', 'KWN-2', 'KWN-3', 'KWN-4')
  AND cs.id_capacity_limit <> 2;

-- 2. Existing open future dates: cap -> 2 and recompute closed flag.
-- The recompute mirrors recalculate_collection_date_units (20260518005937):
-- locked_closed is the sticky T-3 hard-close and MUST be OR-ed back in, or a
-- hard-closed imminent date with <2 ID units would silently re-open here (the
-- close-imminent cron never re-touches rows with locked_closed = true).
UPDATE collection_date cd
SET id_capacity_limit = 2,
    id_is_closed      = (cd.locked_closed OR cd.id_units_booked >= 2)
FROM collection_area ca
WHERE ca.id = cd.collection_area_id
  AND ca.client_id = (SELECT id FROM client WHERE slug = 'kwn')
  AND cd.date >= current_date
  AND cd.id_capacity_limit > 2;

-- Sanity check: no Kwinana schedule row, and no future Kwinana date, may sit
-- above the new cap of 2. Asserts the invariant rather than a hardcoded count,
-- so it passes on prod (rows moved) and on a fresh reset (no KWN rows exist).
DO $$
DECLARE
  v_bad_schedule integer;
  v_bad_dates    integer;
BEGIN
  SELECT COUNT(*) INTO v_bad_schedule
  FROM collection_schedule cs
  JOIN collection_area ca ON ca.id = cs.collection_area_id
  WHERE ca.client_id = (SELECT id FROM client WHERE slug = 'kwn')
    AND ca.code IN ('KWN-1', 'KWN-2', 'KWN-3', 'KWN-4')
    AND cs.id_capacity_limit > 2;

  SELECT COUNT(*) INTO v_bad_dates
  FROM collection_date cd
  JOIN collection_area ca ON ca.id = cd.collection_area_id
  WHERE ca.client_id = (SELECT id FROM client WHERE slug = 'kwn')
    AND cd.date >= current_date
    AND cd.id_capacity_limit > 2;

  IF v_bad_schedule <> 0 OR v_bad_dates <> 0 THEN
    RAISE EXCEPTION
      'KWN ID cap reduction incomplete: % schedule row(s) and % future date(s) still above 2',
      v_bad_schedule, v_bad_dates;
  END IF;
END $$;
