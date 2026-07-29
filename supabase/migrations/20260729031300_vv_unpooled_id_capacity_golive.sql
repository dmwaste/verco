-- WMRC Stage 2 punch-list item 5 (#458): give unpooled VV areas real ID
-- (illegal dumping) capacity, gated to each council's go-live date.
--
-- Root cause (prod investigation 29/07/2026): every unpooled VV area's
-- collection_schedule template had id_capacity_limit = 0, and a rows-only
-- backfill on 21/07 raised existing collection_date rows to 10 for ~5 weeks
-- only (to 01/09) — the classic two-sources trap (template + rows; see the
-- KWN ID 10→2 change). Beyond 01/09 every date had 0 ID capacity and the
-- nightly generate-collection-dates seeder kept minting more 0-capacity
-- dates, so council staff saw "No upcoming ID-eligible collection dates".
--
-- Decisions (Dan, 29/07/2026):
--   * Unpooled VV ID capacity = 5/day (pool stays 10/day shared — untouched).
--   * ID opens from each council's go-live: 03/08 EAS, FRE-S, VIN;
--     17/08 SUB, VIC, SOP, CAM-A, CAM-B. Pre-go-live dates get 0.
--   * The 01/09 horizon was NOT deliberate — no horizon; template carries 5
--     so every future seeded date arrives with capacity.
--
-- Reset-safe: all statements join through client.slug = 'vergevalet'; on a
-- fresh `db reset` (VV not migration-seeded) every UPDATE matches 0 rows and
-- the DO block's invariant (zero rows off-formula) holds vacuously.
-- Idempotent: every UPDATE is predicated on stored <> target.

-- 1. Template → 5/day for all unpooled VV schedules (future seeded dates).
UPDATE public.collection_schedule cs
SET id_capacity_limit = 5
FROM public.collection_area ca
JOIN public.client cl ON cl.id = ca.client_id
WHERE ca.id = cs.collection_area_id
  AND cl.slug = 'vergevalet'
  AND ca.capacity_pool_id IS NULL
  AND cs.id_capacity_limit IS DISTINCT FROM 5;

-- 2. Existing future rows → 5 from the area's go-live, 0 before it.
--    id_units_booked = 0 guard: never squeeze a limit under a real booking
--    (audited 29/07: no future unpooled VV row has booked ID units).
WITH golive(code, golive_date) AS (
  VALUES
    ('EAS',   DATE '2026-08-03'),
    ('FRE-S', DATE '2026-08-03'),
    ('VIN',   DATE '2026-08-03'),
    ('SUB',   DATE '2026-08-17'),
    ('VIC',   DATE '2026-08-17'),
    ('SOP',   DATE '2026-08-17'),
    ('CAM-A', DATE '2026-08-17'),
    ('CAM-B', DATE '2026-08-17')
)
UPDATE public.collection_date cd
SET id_capacity_limit = CASE WHEN cd.date >= g.golive_date THEN 5 ELSE 0 END
FROM public.collection_area ca
JOIN public.client cl ON cl.id = ca.client_id
JOIN golive g ON g.code = ca.code
WHERE cd.collection_area_id = ca.id
  AND cl.slug = 'vergevalet'
  AND ca.capacity_pool_id IS NULL
  AND cd.date >= CURRENT_DATE
  AND cd.id_units_booked = 0
  AND cd.id_capacity_limit IS DISTINCT FROM
      (CASE WHEN cd.date >= g.golive_date THEN 5 ELSE 0 END);

-- 3. Flags → the counter trigger's own formula (locked stays locked; open
--    exactly where capacity remains). Also settles the seeder-born rows that
--    were open-flagged at 0 capacity.
UPDATE public.collection_date cd
SET id_is_closed = (cd.locked_closed OR cd.id_units_booked >= cd.id_capacity_limit)
FROM public.collection_area ca
JOIN public.client cl ON cl.id = ca.client_id
WHERE cd.collection_area_id = ca.id
  AND cl.slug = 'vergevalet'
  AND ca.capacity_pool_id IS NULL
  AND cd.date >= CURRENT_DATE
  AND cd.id_is_closed IS DISTINCT FROM
      (cd.locked_closed OR cd.id_units_booked >= cd.id_capacity_limit);

-- 4. Invariant: no future unpooled VV row may be off the trigger formula.
DO $$
DECLARE
  bad integer;
BEGIN
  SELECT COUNT(*) INTO bad
  FROM public.collection_date cd
  JOIN public.collection_area ca ON ca.id = cd.collection_area_id
  JOIN public.client cl ON cl.id = ca.client_id
  WHERE cl.slug = 'vergevalet'
    AND ca.capacity_pool_id IS NULL
    AND cd.date >= CURRENT_DATE
    AND cd.id_is_closed IS DISTINCT FROM
        (cd.locked_closed OR cd.id_units_booked >= cd.id_capacity_limit);
  IF bad > 0 THEN
    RAISE EXCEPTION 'vv_unpooled_id_capacity_golive: % future rows off the closed-flag formula', bad;
  END IF;
END $$;
