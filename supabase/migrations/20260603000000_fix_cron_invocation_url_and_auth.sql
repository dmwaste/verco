-- F1 (BR-0014) part 2: make the cron → Edge Function invocations actually work.
--
-- The cron commands invoked EFs via:
--   url     := current_setting('app.settings.supabase_url') || '/functions/v1/X'
--   headers := 'Bearer ' || current_setting('app.settings.service_role_key')
-- Both GUCs were never set, and they CANNOT be set on Supabase: `ALTER DATABASE
-- postgres SET app.settings.*` returns `42501 permission denied` for the project
-- `postgres` role (even in the SQL Editor) — that namespace is reserved for the
-- platform superuser. So every cron failed (after pg_net was enabled) with
-- `unrecognized configuration parameter`. This was the real, original reason the
-- crons never ran.
--
-- Fix: drop the GUC dependency entirely.
--   * URL  — hardcode the project URL (not a secret).
--   * Auth — the cron-invoked EFs are all `verify_jwt = false` AND build their
--            Supabase client from their own `SUPABASE_SERVICE_ROLE_KEY` env var
--            (not the incoming bearer). So the bearer is only a routing token;
--            the public anon key (safe to commit) is sufficient. The EFs still
--            do their privileged work with their env service-role key.
--
-- Requires pg_net (enabled in 20260602010100_enable_pg_net.sql).
-- cron.schedule(jobname, ...) upserts by name, so re-applying is idempotent.
-- Only the 6 EF-invoking jobs are touched; `close-imminent-dates` is pure SQL.

DO $$
DECLARE
  v_base   text := 'https://tfddjmplcizfirxqhotv.supabase.co/functions/v1/';
  -- Public anon (publishable) key — used purely as a routing bearer for
  -- verify_jwt=false functions. Not a secret (shipped in the web bundle).
  v_bearer text := 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRmZGRqbXBsY2l6ZmlyeHFob3R2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1MDEwOTIsImV4cCI6MjA5MDA3NzA5Mn0.gz-ePcpnyyKfIQ2Xp1zbAyRHTdaSEoUHdcv51-_dHkE';
  v_job    record;
BEGIN
  FOR v_job IN
    SELECT * FROM (VALUES
      ('handle-expired-payments',   '5 * * * *'),
      ('transition-scheduled',      '25 7 * * *'),
      ('auto-close-notices',        '0 18 * * *'),
      ('generate-collection-dates', '0 19 * * *'),
      ('nightly-sync-to-dm-ops',    '0 19 * * *'),
      ('send-collection-reminders', '0 1 * * *')
    ) AS t(name, schedule)
  LOOP
    PERFORM cron.schedule(
      v_job.name,
      v_job.schedule,
      format(
        $cmd$
        SELECT net.http_post(
          url := %L,
          headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json'),
          body := '{}'::jsonb
        );
        $cmd$,
        v_base || v_job.name,
        v_bearer
      )
    );
  END LOOP;
END $$;
