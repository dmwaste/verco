-- Explicit pg_net timeouts for every remaining cron-invoked Edge Function.
--
-- Follow-up to 20260713040000 (12/07/2026 incident): pg_net's default 5s
-- timeout_milliseconds aborts the cron's HTTP request while the EF is still
-- working, and the Edge Runtime then terminates the isolate shortly after the
-- client goes away — killing the run mid-write. That migration fixed the two
-- crons implicated in the incident; this one converges the rest of the fleet
-- (flagged by the 13/07/2026 pre-cut review, data-migration + adversarial
-- passes). Untouched: close-imminent-dates (direct SQL, no pg_net),
-- push-orders-to-optimoroute (150s) and sync-completions-to-optimoroute (30s)
-- (already carry timeouts).
--
-- Sizing — a timeout is a cap, not a cost (it holds a pg_net slot only while
-- the EF is actually still running); 150s = Supabase's request-idle ceiling:
--   150s  nightly volume-scaling batches: nightly-sync-to-dm-ops (500-row
--         upsert chunks grow with booking volume), send-collection-reminders
--         (sequential per-booking send-notification EF→EF calls)
--    60s  per-row external-call loops: pull-optimoroute-routes (3-day window,
--         one OR getRoutes call per date + paginated stop updates),
--         sync-optimoroute-cancellations (a wholesale-cancelled locked date
--         approaches the incident's ~490 sequential row updates ≈ 20–25s, so
--         the 30s first guess was too tight), handle-expired-payments
--         (per-row Stripe session retrieves on backlog), generate-collection-
--         dates, transition-scheduled (per-booking rows on collection-eve
--         peaks)
--    30s  bounded work: auto-close-notices (two bulk UPDATEs),
--         notification-health-check (per-channel counts + one webhook POST)
--
-- Jobnames, schedules, URLs, and bearers are IDENTICAL to the current
-- registrations (legacy anon JWT for the pre-July jobs, publishable key for
-- the OptimoRoute jobs; both are public-by-design and gitleaks-allowlisted) —
-- the only change per job is the explicit timeout_milliseconds. Idempotent by
-- jobname via the unschedule-then-schedule pattern. EF slug == jobname for
-- every job below.

DO $$
DECLARE
  v_base text := 'https://tfddjmplcizfirxqhotv.supabase.co/functions/v1';
  v_anon text := 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRmZGRqbXBsY2l6ZmlyeHFob3R2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1MDEwOTIsImV4cCI6MjA5MDA3NzA5Mn0.gz-ePcpnyyKfIQ2Xp1zbAyRHTdaSEoUHdcv51-_dHkE';
  v_pub  text := 'Bearer sb_publishable_IKPk11qLAiKp_-vbDF3Rug_VMhUh2dy';
  v_job  record;
BEGIN
  FOR v_job IN
    SELECT *
    FROM (VALUES
      ('pull-optimoroute-routes',        '50 */4 * * *', v_pub,  60000),
      ('sync-optimoroute-cancellations', '20 * * * *',   v_pub,  60000),
      ('nightly-sync-to-dm-ops',         '0 19 * * *',   v_anon, 150000),
      ('send-collection-reminders',      '0 1 * * *',    v_anon, 150000),
      ('handle-expired-payments',        '5 * * * *',    v_anon, 60000),
      ('generate-collection-dates',      '0 19 * * *',   v_anon, 60000),
      ('transition-scheduled',           '25 7 * * *',   v_anon, 60000),
      ('auto-close-notices',             '0 18 * * *',   v_anon, 30000),
      ('notification-health-check',      '15 */3 * * *', v_anon, 30000)
    ) AS t(jobname, schedule, bearer, timeout_ms)
  LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_job.jobname) THEN
      PERFORM cron.unschedule(v_job.jobname);
    END IF;

    PERFORM cron.schedule(
      v_job.jobname,
      v_job.schedule,
      format(
        $cmd$
        SELECT net.http_post(
          url := %L,
          headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json'),
          body := '{}'::jsonb,
          timeout_milliseconds := %s
        );
        $cmd$,
        v_base || '/' || v_job.jobname,
        v_job.bearer,
        v_job.timeout_ms
      )
    );
  END LOOP;
END $$;
