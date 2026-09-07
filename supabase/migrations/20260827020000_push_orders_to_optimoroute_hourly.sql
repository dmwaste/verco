-- push-orders-to-optimoroute: daily at 03:10 AWST → hourly at :10.
--
-- Routes are pushed to the crews at 8pm the night before, so anything that
-- reaches OptimoRoute after that never surfaces to the crew at all. The push
-- EF ran once a day at 03:10 AWST — 7 hours AFTER the dispatch it needed to
-- beat. Any booking moved onto (or newly landing on) an already-locked date
-- between 03:10 and 20:00 on the day before collection missed that window
-- entirely: its order reached OptimoRoute at 03:10 on the collection morning,
-- with the crew's route already out. A ~17-hour hole in which a resident is
-- booked, is on the Verco run sheet, and is not on the truck's route.
--
-- Hourly closes it: any change is in OptimoRoute within the hour, while ops
-- are still planning and well before the 8pm cut. Same for the sibling
-- migration 20260827010000 in the other direction — a cancelled stop is now
-- swept out of OptimoRoute within the hour instead of at 03:10 the next day.
--
-- Safe to run hourly, by the EF's own design:
--   · Pass 1 is a pure DB diff; the routing API is only called when a stop
--     actually needs pushing.
--   · Pass 2 pushes ONLY stops with pushed_at IS NULL — an unchanged,
--     already-planned order is never blind-re-SYNCed out from under ops.
--   · pushed_at is reset only on a genuine payload change (date, address,
--     coordinates, services, waste location, driver notes). The 12/07/2026
--     refresh-storm (a JSON.stringify jsonb key-order diff) is fixed and
--     regression-tested in servicesSummariesEqual; the last ten production
--     runs report stops_refreshed 0 or 1, so hourly adds no churn.
--   · The EF is documented idempotent and safe to re-run at any time.
--
-- Reads the existing command back rather than restating it, so the Vault
-- X-Cron-Secret header injected by 20260822090000 (and the pg_net timeout
-- from 20260713100000) cannot be silently dropped by this retiming.
-- cron.schedule upserts by name, so this is re-appliable.
DO $$
DECLARE
  v_cmd text;
BEGIN
  SELECT command INTO v_cmd FROM cron.job WHERE jobname = 'push-orders-to-optimoroute';

  IF v_cmd IS NULL THEN
    RAISE NOTICE 'push-orders-to-optimoroute is not scheduled — nothing to retime';
    RETURN;
  END IF;

  IF v_cmd NOT LIKE '%X-Cron-Secret%' THEN
    RAISE EXCEPTION
      'push-orders-to-optimoroute command has no X-Cron-Secret header — refusing to reschedule (see 20260822090000)';
  END IF;

  -- :10 keeps the push 10 minutes ahead of sync-optimoroute-cancellations
  -- (xx:20), so a stop cancelled by pass 1 has its OptimoRoute order deleted
  -- in the same ten-minute window rather than an hour later.
  PERFORM cron.schedule('push-orders-to-optimoroute', '10 * * * *', v_cmd);
END $$;
