-- Seed collection_schedule for City of Kwinana (kwn) areas KWN-1..KWN-4.
--
-- Why this exists
-- ----------------
-- The generate-collection-dates cron reads collection_schedule WHERE is_active
-- to roll collection_date rows forward 16 weeks. VV areas were seeded in
-- 20260513090000_collection_schedule.sql (17 rows), but KWN never got a
-- collection_schedule row. KWN's existing collection_date rows (extending to
-- mid-Dec 2026) were created outside the normal flow, so bookings + the
-- transition-scheduled cron work FOR NOW — but once those hand-made dates run
-- out (~Dec 2026) the generator would NOT extend KWN, and KWN bookings could
-- no longer be placed/scheduled. This migration closes that gap.
--
-- Derivation (verified against prod collection_date on 2026-07-03, confirmed
-- with ops)
-- ----------------------------------------------------------------------------
--   day_of_week: one zone per weekday, derived from ~29-30 existing dates each
--     KWN-1 → Mon (1), KWN-2 → Tue (2), KWN-3 → Wed (3), KWN-4 → Thu (4)
--   bulk_capacity_limit = 70: KWN stepped 60→70/day around Jul 2026; every
--     Sep-Dec 2026 date runs at 70, so 70 is the current operating value.
--   anc_capacity_limit = 60, id_capacity_limit = 10: unchanged in prod; mirror
--     current values so forward-generated dates stay identical to today's.
--
-- KWN is UNPOOLED (capacity_pool_id IS NULL on all four areas), so real
-- per-area limits belong here — unlike VV's MCP pool members, which carry 0 on
-- the area and track capacity on capacity_pool_schedule.
--
-- Idempotent: ON CONFLICT (collection_area_id, day_of_week) DO UPDATE, so a
-- re-run refreshes limits without duplicating rows. Existing future
-- collection_date rows are NOT retroactively altered by the generator; ops can
-- UPDATE them manually if the 60→70 change should backfill.
--
-- Environment note: the KWN client + areas are NOT created by any migration —
-- they were inserted into prod manually (see scripts/import-kwn-properties.ts,
-- which hardcodes their prod IDs) and into the local/E2E stack by
-- supabase/seed.sql, which runs AFTER migrations. So during a fresh
-- `supabase db reset` this migration finds zero KWN areas and is a harmless
-- no-op (the INSERT ... JOIN kwn_areas resolves to nothing). The sanity check
-- below therefore asserts the *invariant* — every KWN area that exists got a
-- schedule row — rather than a hardcoded count, so it passes both on prod
-- (4 areas → 4 rows) and on a fresh reset (0 areas → 0 rows).
WITH kwn_areas AS (
  SELECT id, code FROM collection_area
  WHERE client_id = (SELECT id FROM client WHERE slug = 'kwn')
    AND code IN ('KWN-1', 'KWN-2', 'KWN-3', 'KWN-4')
),
schedule AS (
  -- area_code, day_of_week (0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat), bulk, anc, id
  SELECT * FROM (VALUES
    ('KWN-1'::text, 1::smallint, 70::integer, 60::integer, 10::integer),  -- Mon
    ('KWN-2',       2,           70,          60,          10),           -- Tue
    ('KWN-3',       3,           70,          60,          10),           -- Wed
    ('KWN-4',       4,           70,          60,          10)            -- Thu
  ) AS s(area_code, day_of_week, bulk_cap, anc_cap, id_cap)
)
INSERT INTO collection_schedule (
  collection_area_id, day_of_week, bulk_capacity_limit, anc_capacity_limit, id_capacity_limit
)
SELECT a.id, s.day_of_week, s.bulk_cap, s.anc_cap, s.id_cap
FROM schedule s
JOIN kwn_areas a ON a.code = s.area_code
ON CONFLICT (collection_area_id, day_of_week) DO UPDATE
  SET bulk_capacity_limit = EXCLUDED.bulk_capacity_limit,
      anc_capacity_limit  = EXCLUDED.anc_capacity_limit,
      id_capacity_limit   = EXCLUDED.id_capacity_limit,
      updated_at          = now();

-- Sanity check: every KWN area present in this database must now have a
-- schedule row. On prod that is 4 = 4; on a fresh reset (no KWN areas yet) it
-- is 0 = 0. Catches the real failure — an area present but not scheduled.
DO $$
DECLARE
  v_area_count     integer;
  v_schedule_count integer;
BEGIN
  SELECT COUNT(*) INTO v_area_count
  FROM collection_area ca
  WHERE ca.client_id = (SELECT id FROM client WHERE slug = 'kwn')
    AND ca.code IN ('KWN-1', 'KWN-2', 'KWN-3', 'KWN-4');

  SELECT COUNT(*) INTO v_schedule_count
  FROM collection_schedule cs
  JOIN collection_area ca ON ca.id = cs.collection_area_id
  WHERE ca.client_id = (SELECT id FROM client WHERE slug = 'kwn')
    AND ca.code IN ('KWN-1', 'KWN-2', 'KWN-3', 'KWN-4');

  IF v_schedule_count <> v_area_count THEN
    RAISE EXCEPTION
      'KWN schedule seed mismatch: % areas present but % schedule rows',
      v_area_count, v_schedule_count;
  END IF;
END $$;
