-- #575: schedule the daily stale-closeout alert.
--
-- `stale-closeout-check` names, once, each collection day that is now 3+ days
-- past with dispatched stops still not closed out (and any Scheduled booking
-- never dispatched), and restates the standing backlog on Mondays. Cambridge
-- closed out 0 of 204 stops for two weeks before anyone noticed (#568). Alerts
-- go to the ops Teams channel via OPS_ALERT_WEBHOOK_URL (#576).
--
-- 01:35 UTC = 09:35 AWST daily: start of the office day, after the 09:00–09:30
-- reminder ticks, and on a minute no other job uses.
--
-- Command shape matches the live jobs: hardcoded project URL, the public anon
-- key as a routing bearer (the EF is verify_jwt=false and reads with its own
-- SUPABASE_SERVICE_ROLE_KEY), and the X-Cron-Secret header read from Vault at
-- run time — 20260822090000 only patched jobs that existed then, so a new job
-- must carry it itself or cronHandler rejects it. COALESCE('') keeps a fresh
-- `db reset` (no Vault row) from erroring; the EF then rejects loudly.
--
-- Re-runnable: unschedule-if-exists, then schedule.
-- Rollback: SELECT cron.unschedule('stale-closeout-check'); — the EF writes
-- nothing, so there is no data to unwind.

DO $$
DECLARE
  v_url    text := 'https://tfddjmplcizfirxqhotv.supabase.co/functions/v1/stale-closeout-check';
  -- Public anon (publishable) key — routing bearer only, not a secret.
  v_bearer text := 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRmZGRqbXBsY2l6ZmlyeHFob3R2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1MDEwOTIsImV4cCI6MjA5MDA3NzA5Mn0.gz-ePcpnyyKfIQ2Xp1zbAyRHTdaSEoUHdcv51-_dHkE';
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'stale-closeout-check') THEN
    PERFORM cron.unschedule('stale-closeout-check');
  END IF;

  PERFORM cron.schedule(
    'stale-closeout-check',
    '35 1 * * *',
    format(
      $cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('X-Cron-Secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_ef_secret' LIMIT 1), ''), 'Authorization', %L, 'Content-Type', 'application/json'),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      );
      $cmd$,
      v_url,
      v_bearer
    )
  );
END $$;
