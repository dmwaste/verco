-- Field/ranger mobile (plan 2026-06-10) — A5: OptimoRoute sync crons.
--
-- Same invocation pattern as 20260603000000: hardcoded project URL + the
-- public anon key as a pure routing bearer. All three EFs are
-- verify_jwt=false and do their privileged work with their own
-- SUPABASE_SERVICE_ROLE_KEY env. Requires pg_net (20260602010100).
-- cron.schedule(jobname, ...) upserts by name → idempotent re-apply.
--
-- Schedules (UTC → AWST=UTC+8):
--   push-orders-to-optimoroute    19:10 daily → 03:10 AWST. 40 min after
--     close-imminent-dates (18:30) locks T-3 dates, 10 min clear of the
--     19:00 pair (generate-collection-dates, nightly-sync-to-dm-ops).
--     Friday's tick pushes Monday's orders → ops can plan Friday night.
--   sync-optimoroute-cancellations hourly :20 — covers the lock → day-prior
--     15:30 AWST cutoff window; the EF's own date filter self-bounds it.
--   pull-optimoroute-routes       50 */4 → 04:50/08:50/12:50/16:50/20:50/
--     00:50 AWST. Covers WA planning hours plus a pre-crew 04:50 pull; the
--     admin "Refresh routes" button covers the gaps.

DO $$
DECLARE
  v_base   text := 'https://tfddjmplcizfirxqhotv.supabase.co/functions/v1/';
  -- Public anon (publishable) key — routing bearer only, not a secret.
  v_bearer text := 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRmZGRqbXBsY2l6ZmlyeHFob3R2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1MDEwOTIsImV4cCI6MjA5MDA3NzA5Mn0.gz-ePcpnyyKfIQ2Xp1zbAyRHTdaSEoUHdcv51-_dHkE';
  v_job    record;
BEGIN
  FOR v_job IN
    SELECT * FROM (VALUES
      ('push-orders-to-optimoroute',     '10 19 * * *'),
      ('sync-optimoroute-cancellations', '20 * * * *'),
      ('pull-optimoroute-routes',        '50 */4 * * *')
    ) AS t(name, schedule)
  LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_job.name) THEN
      PERFORM cron.unschedule(v_job.name);
    END IF;

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
