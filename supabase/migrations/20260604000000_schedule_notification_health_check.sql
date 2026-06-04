-- VER-254: schedule the notification-outage watchdog.
--
-- The `notification-health-check` Edge Function tallies email/SMS sends in
-- `notification_log` over a trailing window and alerts an ops webhook when a
-- channel looks dark or is failure-spiking. This closes the silent-outage gap
-- behind the 14 Apr `verify_jwt` and 18 May SendGrid-key incidents.
--
-- Invocation matches the established cron pattern (see
-- 20260603000000_fix_cron_invocation_url_and_auth.sql): hardcoded project URL
-- + the public anon key as a routing bearer (the EF is verify_jwt=false and
-- does its privileged work with its own SUPABASE_SERVICE_ROLE_KEY env — the
-- bearer is only a routing token, not a secret). Requires pg_net.
--
-- Every 3 hours at :15 — offset from the other crons' :00/:05/:25 minutes so
-- the watchdog reads after the booking/payment crons have written their rows.
-- cron.schedule(jobname, ...) upserts by name, so re-applying is idempotent.

DO $$
DECLARE
  v_url    text := 'https://tfddjmplcizfirxqhotv.supabase.co/functions/v1/notification-health-check';
  -- Public anon (publishable) key — routing bearer for the verify_jwt=false
  -- function. Not a secret (shipped in the web bundle).
  v_bearer text := 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRmZGRqbXBsY2l6ZmlyeHFob3R2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1MDEwOTIsImV4cCI6MjA5MDA3NzA5Mn0.gz-ePcpnyyKfIQ2Xp1zbAyRHTdaSEoUHdcv51-_dHkE';
BEGIN
  PERFORM cron.schedule(
    'notification-health-check',
    '15 */3 * * *',
    format(
      $cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json'),
        body := '{}'::jsonb
      );
      $cmd$,
      v_url,
      v_bearer
    )
  );
END $$;
