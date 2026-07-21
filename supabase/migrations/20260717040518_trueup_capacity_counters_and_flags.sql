-- True-up capacity counters + closed flags to the recalc trigger's own formula.
--
-- Why this exists
-- ----------------
-- Until 20260717022049 the counter trigger (recalculate_collection_date_units)
-- ran SECURITY INVOKER, so counter recomputes silently no-opped (0 rows under
-- RLS) whenever the writing session wasn't contractor-admin. That era left
-- stored counters/flags drifted from the trigger's formula. The trigger now
-- self-heals each date whenever any booking_item write touches it, but dates
-- with no traffic stay wrong indefinitely. Audit of prod (2026-07-17, exact
-- trigger formula, future dates only):
--
--   * 3 KWN dates OVER-counted (bulk 70→68/69/68, anc 30→29/56→53) and
--     therefore marked bulk_is_closed while genuinely having free slots —
--     bookable capacity hidden from residents on the three busiest upcoming
--     KWN dates.
--   * 265 future rows (168 anc / 94 id / 3 bulk on collection_date, 21 on
--     collection_date_pool) with capacity_limit = 0 showing is_closed = false:
--     never recomputed, and the trigger's formula (units >= limit, i.e. 0 >= 0)
--     says closed. Functionally latent (the capacity RPC rejects zero
--     availability regardless) but any trigger touch flips them one by one —
--     truing them up in bulk keeps the flags internally consistent.
--   * Pool counters (VV): zero drift.
--
-- What this does
-- ---------------
-- Recomputes, for FUTURE rows only ("future" per the UTC prod clock — a
-- recompute-to-truth is safe for any date, so the AWST offset is harmless):
--   1. unpooled collection_date counters  → trigger formula truth
--   2. unpooled collection_date *_is_closed → locked_closed OR (units >= limit)
--   3. collection_date_pool counters      → trigger formula truth (pooled areas
--      keep counters on the pool row; their per-date counter columns are dead
--      data the trigger never maintains and are deliberately left untouched)
--   4. collection_date_pool *_is_closed   → same formula
-- The counting formula is copied verbatim from the trigger: SUM(no_services)
-- per category code over booking_item joined to booking, excluding bookings in
-- 'Cancelled' / 'Pending Payment'.
--
-- Idempotent: every UPDATE is predicated on stored <> formula, so a re-run (or
-- a concurrent trigger firing mid-migration — it writes the same formula)
-- touches nothing. Reset-safe: on a fresh `db reset` there are no drifted rows
-- and every statement no-ops; the DO block asserts the invariant (zero future
-- rows off-formula), not a count.

-- 1. Unpooled counters → truth
WITH truth AS (
  SELECT bi.collection_date_id,
         COALESCE(SUM(bi.no_services) FILTER (WHERE c.code = 'bulk'), 0) AS t_bulk,
         COALESCE(SUM(bi.no_services) FILTER (WHERE c.code = 'anc'), 0)  AS t_anc,
         COALESCE(SUM(bi.no_services) FILTER (WHERE c.code = 'id'), 0)   AS t_id
  FROM booking_item bi
  JOIN booking b ON b.id = bi.booking_id
  JOIN service s ON s.id = bi.service_id
  JOIN category c ON c.id = s.category_id
  WHERE b.status NOT IN ('Cancelled', 'Pending Payment')
  GROUP BY bi.collection_date_id
),
tgt AS (
  SELECT cd.id,
         COALESCE(t.t_bulk, 0) AS t_bulk,
         COALESCE(t.t_anc, 0)  AS t_anc,
         COALESCE(t.t_id, 0)   AS t_id
  FROM collection_date cd
  JOIN collection_area ca ON ca.id = cd.collection_area_id
  LEFT JOIN truth t ON t.collection_date_id = cd.id
  WHERE ca.capacity_pool_id IS NULL
    AND cd.date >= current_date
)
UPDATE collection_date cd
SET bulk_units_booked = tgt.t_bulk,
    anc_units_booked  = tgt.t_anc,
    id_units_booked   = tgt.t_id
FROM tgt
WHERE cd.id = tgt.id
  AND (cd.bulk_units_booked <> tgt.t_bulk
    OR cd.anc_units_booked  <> tgt.t_anc
    OR cd.id_units_booked   <> tgt.t_id);

-- 2. Unpooled closed flags → formula (reads the corrected counters)
UPDATE collection_date cd
SET bulk_is_closed = cd.locked_closed OR (cd.bulk_units_booked >= cd.bulk_capacity_limit),
    anc_is_closed  = cd.locked_closed OR (cd.anc_units_booked  >= cd.anc_capacity_limit),
    id_is_closed   = cd.locked_closed OR (cd.id_units_booked   >= cd.id_capacity_limit)
FROM collection_area ca
WHERE ca.id = cd.collection_area_id
  AND ca.capacity_pool_id IS NULL
  AND cd.date >= current_date
  AND (cd.bulk_is_closed <> (cd.locked_closed OR (cd.bulk_units_booked >= cd.bulk_capacity_limit))
    OR cd.anc_is_closed  <> (cd.locked_closed OR (cd.anc_units_booked  >= cd.anc_capacity_limit))
    OR cd.id_is_closed   <> (cd.locked_closed OR (cd.id_units_booked   >= cd.id_capacity_limit)));

-- 3. Pool counters → truth (zero drift at time of writing; kept for idempotent
--    completeness and any drift accrued between audit and apply)
WITH pool_truth AS (
  SELECT ca2.capacity_pool_id, cd2.date,
         COALESCE(SUM(bi.no_services) FILTER (WHERE c.code = 'bulk'), 0) AS t_bulk,
         COALESCE(SUM(bi.no_services) FILTER (WHERE c.code = 'anc'), 0)  AS t_anc,
         COALESCE(SUM(bi.no_services) FILTER (WHERE c.code = 'id'), 0)   AS t_id
  FROM booking_item bi
  JOIN booking b ON b.id = bi.booking_id
  JOIN service s ON s.id = bi.service_id
  JOIN category c ON c.id = s.category_id
  JOIN collection_date cd2 ON cd2.id = bi.collection_date_id
  JOIN collection_area ca2 ON ca2.id = cd2.collection_area_id
  WHERE ca2.capacity_pool_id IS NOT NULL
    AND b.status NOT IN ('Cancelled', 'Pending Payment')
  GROUP BY ca2.capacity_pool_id, cd2.date
),
ptgt AS (
  SELECT cdp.capacity_pool_id, cdp.date,
         COALESCE(t.t_bulk, 0) AS t_bulk,
         COALESCE(t.t_anc, 0)  AS t_anc,
         COALESCE(t.t_id, 0)   AS t_id
  FROM collection_date_pool cdp
  LEFT JOIN pool_truth t
    ON t.capacity_pool_id = cdp.capacity_pool_id AND t.date = cdp.date
  WHERE cdp.date >= current_date
)
UPDATE collection_date_pool cdp
SET bulk_units_booked = ptgt.t_bulk,
    anc_units_booked  = ptgt.t_anc,
    id_units_booked   = ptgt.t_id
FROM ptgt
WHERE cdp.capacity_pool_id = ptgt.capacity_pool_id
  AND cdp.date = ptgt.date
  AND (cdp.bulk_units_booked <> ptgt.t_bulk
    OR cdp.anc_units_booked  <> ptgt.t_anc
    OR cdp.id_units_booked   <> ptgt.t_id);

-- 4. Pool closed flags → formula
UPDATE collection_date_pool cdp
SET bulk_is_closed = cdp.locked_closed OR (cdp.bulk_units_booked >= cdp.bulk_capacity_limit),
    anc_is_closed  = cdp.locked_closed OR (cdp.anc_units_booked  >= cdp.anc_capacity_limit),
    id_is_closed   = cdp.locked_closed OR (cdp.id_units_booked   >= cdp.id_capacity_limit)
WHERE cdp.date >= current_date
  AND (cdp.bulk_is_closed <> (cdp.locked_closed OR (cdp.bulk_units_booked >= cdp.bulk_capacity_limit))
    OR cdp.anc_is_closed  <> (cdp.locked_closed OR (cdp.anc_units_booked  >= cdp.anc_capacity_limit))
    OR cdp.id_is_closed   <> (cdp.locked_closed OR (cdp.id_units_booked   >= cdp.id_capacity_limit)));

-- Invariant: zero future rows may remain off-formula on either table.
DO $$
DECLARE
  v_bad_dates integer;
  v_bad_pool  integer;
BEGIN
  WITH truth AS (
    SELECT bi.collection_date_id,
           COALESCE(SUM(bi.no_services) FILTER (WHERE c.code = 'bulk'), 0) AS t_bulk,
           COALESCE(SUM(bi.no_services) FILTER (WHERE c.code = 'anc'), 0)  AS t_anc,
           COALESCE(SUM(bi.no_services) FILTER (WHERE c.code = 'id'), 0)   AS t_id
    FROM booking_item bi
    JOIN booking b ON b.id = bi.booking_id
    JOIN service s ON s.id = bi.service_id
    JOIN category c ON c.id = s.category_id
    WHERE b.status NOT IN ('Cancelled', 'Pending Payment')
    GROUP BY bi.collection_date_id
  )
  SELECT COUNT(*) INTO v_bad_dates
  FROM collection_date cd
  JOIN collection_area ca ON ca.id = cd.collection_area_id
  LEFT JOIN truth t ON t.collection_date_id = cd.id
  WHERE ca.capacity_pool_id IS NULL
    AND cd.date >= current_date
    AND (cd.bulk_units_booked <> COALESCE(t.t_bulk, 0)
      OR cd.anc_units_booked  <> COALESCE(t.t_anc, 0)
      OR cd.id_units_booked   <> COALESCE(t.t_id, 0)
      OR cd.bulk_is_closed <> (cd.locked_closed OR (COALESCE(t.t_bulk, 0) >= cd.bulk_capacity_limit))
      OR cd.anc_is_closed  <> (cd.locked_closed OR (COALESCE(t.t_anc, 0)  >= cd.anc_capacity_limit))
      OR cd.id_is_closed   <> (cd.locked_closed OR (COALESCE(t.t_id, 0)   >= cd.id_capacity_limit)));

  WITH pool_truth AS (
    SELECT ca2.capacity_pool_id, cd2.date,
           COALESCE(SUM(bi.no_services) FILTER (WHERE c.code = 'bulk'), 0) AS t_bulk,
           COALESCE(SUM(bi.no_services) FILTER (WHERE c.code = 'anc'), 0)  AS t_anc,
           COALESCE(SUM(bi.no_services) FILTER (WHERE c.code = 'id'), 0)   AS t_id
    FROM booking_item bi
    JOIN booking b ON b.id = bi.booking_id
    JOIN service s ON s.id = bi.service_id
    JOIN category c ON c.id = s.category_id
    JOIN collection_date cd2 ON cd2.id = bi.collection_date_id
    JOIN collection_area ca2 ON ca2.id = cd2.collection_area_id
    WHERE ca2.capacity_pool_id IS NOT NULL
      AND b.status NOT IN ('Cancelled', 'Pending Payment')
    GROUP BY ca2.capacity_pool_id, cd2.date
  )
  SELECT COUNT(*) INTO v_bad_pool
  FROM collection_date_pool cdp
  LEFT JOIN pool_truth t
    ON t.capacity_pool_id = cdp.capacity_pool_id AND t.date = cdp.date
  WHERE cdp.date >= current_date
    AND (cdp.bulk_units_booked <> COALESCE(t.t_bulk, 0)
      OR cdp.anc_units_booked  <> COALESCE(t.t_anc, 0)
      OR cdp.id_units_booked   <> COALESCE(t.t_id, 0)
      OR cdp.bulk_is_closed <> (cdp.locked_closed OR (COALESCE(t.t_bulk, 0) >= cdp.bulk_capacity_limit))
      OR cdp.anc_is_closed  <> (cdp.locked_closed OR (COALESCE(t.t_anc, 0)  >= cdp.anc_capacity_limit))
      OR cdp.id_is_closed   <> (cdp.locked_closed OR (COALESCE(t.t_id, 0)   >= cdp.id_capacity_limit)));

  IF v_bad_dates <> 0 OR v_bad_pool <> 0 THEN
    RAISE EXCEPTION
      'Capacity true-up incomplete: % collection_date and % collection_date_pool future row(s) still off-formula',
      v_bad_dates, v_bad_pool;
  END IF;
END $$;
