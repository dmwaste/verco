-- Raise pg_net timeouts on the OptimoRoute cron invocations (12/07/2026 incident).
--
-- pg_net's default 5s timeout aborts the HTTP request while the push EF is
-- still working; the Edge Runtime then terminates the isolate shortly after
-- the client goes away. The 12/07 19:10 UTC run died between pass 1 (which
-- resets pushed_at on refreshed stops) and pass 2 (which re-stamps it after
-- re-pushing), stranding every pending stop for 13–16/07 as "never pushed" —
-- so the completions sync (which skips never-pushed stops) reported nothing
-- to OR and residents got no OR notifications. The companion EF change makes
-- payloadDiffers content-based so the nightly run no longer mass-refreshes,
-- but the invocation must still outlive a legitimately long run.
--
-- Applied directly to prod on 13/07/2026 during the incident; this migration
-- converges the checked-in cron definitions (cron.schedule is idempotent by
-- jobname via the unschedule-then-schedule pattern).

DO $$
DECLARE
  v_base   text := 'https://tfddjmplcizfirxqhotv.supabase.co/functions/v1';
  v_bearer text := 'Bearer sb_publishable_IKPk11qLAiKp_-vbDF3Rug_VMhUh2dy';
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'push-orders-to-optimoroute') THEN
    PERFORM cron.unschedule('push-orders-to-optimoroute');
  END IF;

  PERFORM cron.schedule(
    'push-orders-to-optimoroute',
    '10 19 * * *',
    format(
      $cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json'),
        body := '{}'::jsonb,
        timeout_milliseconds := 150000
      );
      $cmd$,
      v_base || '/push-orders-to-optimoroute',
      v_bearer
    )
  );

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-completions-to-optimoroute') THEN
    PERFORM cron.unschedule('sync-completions-to-optimoroute');
  END IF;

  PERFORM cron.schedule(
    'sync-completions-to-optimoroute',
    '*/5 * * * *',
    format(
      $cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json'),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      );
      $cmd$,
      v_base || '/sync-completions-to-optimoroute',
      v_bearer
    )
  );
END $$;
