-- Hard close collection dates 3 days before collection.
--
-- The recalculate_collection_date_units trigger already flips is_closed
-- when capacity is fully booked. But for dates that never reach capacity,
-- the booking flow stays open right up to the collection day — staff need
-- a few days' clearance to plan routes, finalise crews, and stop accepting
-- last-minute bookings.
--
-- This migration adds a sticky `locked_closed` flag and a daily cron that
-- sets it for any open collection date within the next 3 days. The recalc
-- trigger is updated to OR `locked_closed` into each `is_closed` so a
-- post-lock cancellation can't refund capacity and silently re-open the
-- date.
--
-- Layered on top of 20260518005934_recalc_units_handles_date_change
-- (VER-208's date-change-UPDATE fix). The body below is the FOREACH
-- version with `locked_closed OR …` added to every is_closed assignment.

-- 1. Sticky lock columns
ALTER TABLE collection_date
  ADD COLUMN locked_closed boolean NOT NULL DEFAULT false;

ALTER TABLE collection_date_pool
  ADD COLUMN locked_closed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN collection_date.locked_closed IS
  'Hard-closed by the close-imminent cron (T-3 days). Sticky — survives capacity refunds. OR-d into bulk_is_closed / anc_is_closed / id_is_closed by the recalculate_collection_date_units trigger.';
COMMENT ON COLUMN collection_date_pool.locked_closed IS
  'Hard-closed by the close-imminent cron (T-3 days). Sticky — survives capacity refunds. OR-d into bulk_is_closed / anc_is_closed / id_is_closed by the recalculate_collection_date_units trigger.';

-- 2. Recalc trigger now OR-s locked_closed into each is_closed.
--    Otherwise a cancellation post-lock would refund units, flip
--    units_booked < capacity_limit, and re-open the date.
CREATE OR REPLACE FUNCTION public.recalculate_collection_date_units()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_date_ids uuid[];
  v_date_id  uuid;
  v_pool_id  uuid;
  v_date     date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_date_ids := ARRAY[NEW.collection_date_id];
  ELSIF TG_OP = 'DELETE' THEN
    v_date_ids := ARRAY[OLD.collection_date_id];
  ELSE
    IF OLD.collection_date_id IS DISTINCT FROM NEW.collection_date_id THEN
      v_date_ids := ARRAY[OLD.collection_date_id, NEW.collection_date_id];
    ELSE
      v_date_ids := ARRAY[NEW.collection_date_id];
    END IF;
  END IF;

  FOREACH v_date_id IN ARRAY v_date_ids LOOP
    SELECT ca.capacity_pool_id, cd.date
    INTO v_pool_id, v_date
    FROM collection_date cd
    JOIN collection_area ca ON ca.id = cd.collection_area_id
    WHERE cd.id = v_date_id;

    IF v_pool_id IS NULL THEN
      UPDATE collection_date cd
      SET
        bulk_units_booked = (
          SELECT COALESCE(SUM(bi.no_services), 0)
          FROM booking_item bi
          JOIN booking b ON b.id = bi.booking_id
          JOIN service s ON s.id = bi.service_id
          JOIN category c ON c.id = s.category_id
          WHERE bi.collection_date_id = cd.id
          AND c.code = 'bulk'
          AND b.status NOT IN ('Cancelled', 'Pending Payment')
        ),
        anc_units_booked = (
          SELECT COALESCE(SUM(bi.no_services), 0)
          FROM booking_item bi
          JOIN booking b ON b.id = bi.booking_id
          JOIN service s ON s.id = bi.service_id
          JOIN category c ON c.id = s.category_id
          WHERE bi.collection_date_id = cd.id
          AND c.code = 'anc'
          AND b.status NOT IN ('Cancelled', 'Pending Payment')
        ),
        id_units_booked = (
          SELECT COALESCE(SUM(bi.no_services), 0)
          FROM booking_item bi
          JOIN booking b ON b.id = bi.booking_id
          JOIN service s ON s.id = bi.service_id
          JOIN category c ON c.id = s.category_id
          WHERE bi.collection_date_id = cd.id
          AND c.code = 'id'
          AND b.status NOT IN ('Cancelled', 'Pending Payment')
        )
      WHERE cd.id = v_date_id;

      UPDATE collection_date
      SET
        bulk_is_closed = locked_closed OR (bulk_units_booked >= bulk_capacity_limit),
        anc_is_closed  = locked_closed OR (anc_units_booked  >= anc_capacity_limit),
        id_is_closed   = locked_closed OR (id_units_booked   >= id_capacity_limit)
      WHERE id = v_date_id;
    ELSE
      UPDATE collection_date_pool cdp
      SET
        bulk_units_booked = (
          SELECT COALESCE(SUM(bi.no_services), 0)
          FROM booking_item bi
          JOIN booking b ON b.id = bi.booking_id
          JOIN service s ON s.id = bi.service_id
          JOIN category c ON c.id = s.category_id
          JOIN collection_date cd2 ON cd2.id = bi.collection_date_id
          JOIN collection_area ca2 ON ca2.id = cd2.collection_area_id
          WHERE ca2.capacity_pool_id = v_pool_id
          AND cd2.date = v_date
          AND c.code = 'bulk'
          AND b.status NOT IN ('Cancelled', 'Pending Payment')
        ),
        anc_units_booked = (
          SELECT COALESCE(SUM(bi.no_services), 0)
          FROM booking_item bi
          JOIN booking b ON b.id = bi.booking_id
          JOIN service s ON s.id = bi.service_id
          JOIN category c ON c.id = s.category_id
          JOIN collection_date cd2 ON cd2.id = bi.collection_date_id
          JOIN collection_area ca2 ON ca2.id = cd2.collection_area_id
          WHERE ca2.capacity_pool_id = v_pool_id
          AND cd2.date = v_date
          AND c.code = 'anc'
          AND b.status NOT IN ('Cancelled', 'Pending Payment')
        ),
        id_units_booked = (
          SELECT COALESCE(SUM(bi.no_services), 0)
          FROM booking_item bi
          JOIN booking b ON b.id = bi.booking_id
          JOIN service s ON s.id = bi.service_id
          JOIN category c ON c.id = s.category_id
          JOIN collection_date cd2 ON cd2.id = bi.collection_date_id
          JOIN collection_area ca2 ON ca2.id = cd2.collection_area_id
          WHERE ca2.capacity_pool_id = v_pool_id
          AND cd2.date = v_date
          AND c.code = 'id'
          AND b.status NOT IN ('Cancelled', 'Pending Payment')
        )
      WHERE cdp.capacity_pool_id = v_pool_id AND cdp.date = v_date;

      UPDATE collection_date_pool
      SET
        bulk_is_closed = locked_closed OR (bulk_units_booked >= bulk_capacity_limit),
        anc_is_closed  = locked_closed OR (anc_units_booked  >= anc_capacity_limit),
        id_is_closed   = locked_closed OR (id_units_booked   >= id_capacity_limit)
      WHERE capacity_pool_id = v_pool_id AND date = v_date;
    END IF;
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- 3. The cron worker — pure SQL, called by pg_cron once daily.
--
-- Closes any open collection date (per-area or pool) whose date is within
-- 3 days of today_awst. Sets locked_closed AND immediately sets every
-- bucket's is_closed=true so the booking flow stops accepting submissions
-- in the same statement (don't wait for the next booking_item trigger fire
-- to propagate the lock).
CREATE OR REPLACE FUNCTION public.close_imminent_collection_dates()
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_today_awst date := (now() AT TIME ZONE 'Australia/Perth')::date;
  v_cutoff     date := v_today_awst + 3;
  v_area_count integer;
  v_pool_count integer;
BEGIN
  WITH locked AS (
    UPDATE collection_date
    SET
      locked_closed  = true,
      bulk_is_closed = true,
      anc_is_closed  = true,
      id_is_closed   = true
    WHERE date >= v_today_awst
      AND date <= v_cutoff
      AND locked_closed = false
    RETURNING id
  )
  SELECT COUNT(*) INTO v_area_count FROM locked;

  WITH locked AS (
    UPDATE collection_date_pool
    SET
      locked_closed  = true,
      bulk_is_closed = true,
      anc_is_closed  = true,
      id_is_closed   = true
    WHERE date >= v_today_awst
      AND date <= v_cutoff
      AND locked_closed = false
    RETURNING id
  )
  SELECT COUNT(*) INTO v_pool_count FROM locked;

  RETURN jsonb_build_object(
    'today_awst', v_today_awst,
    'cutoff',     v_cutoff,
    'area_dates_locked', v_area_count,
    'pool_dates_locked', v_pool_count
  );
END;
$$;

COMMENT ON FUNCTION public.close_imminent_collection_dates() IS
  'Hard-closes collection dates within 3 days of today (AWST). Wraps both collection_date and collection_date_pool. Idempotent — only touches rows where locked_closed is currently false. Run daily by pg_cron job close-imminent-dates.';

-- 4. Schedule daily at 18:30 UTC = 02:30 AWST. Slots between the
--    auto-close-notices cron (18:00 UTC) and generate-collection-dates
--    (19:00 UTC). Idempotent re-apply guarded by IF EXISTS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'close-imminent-dates') THEN
    PERFORM cron.unschedule('close-imminent-dates');
  END IF;
END $$;

SELECT cron.schedule(
  'close-imminent-dates',
  '30 18 * * *',
  $cron$SELECT public.close_imminent_collection_dates();$cron$
);

-- 5. One-time backfill: lock any date already within the 3-day window so
--    we don't need to wait 24h for the first cron tick to bring prod into
--    the new invariant.
SELECT public.close_imminent_collection_dates();
