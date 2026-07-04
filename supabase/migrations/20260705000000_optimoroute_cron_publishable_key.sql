-- Re-point the OptimoRoute cron bearer at the publishable API key.
--
-- The project moved to Supabase's new API-key system. Inside edge functions
-- `SUPABASE_ANON_KEY` now resolves to the publishable key (sb_publishable_…),
-- not the legacy anon JWT. pull-optimoroute-routes gates on
-- `bearer !== SUPABASE_ANON_KEY` (a plain string match), so the cron — which
-- was sending the legacy anon JWT (20260610010400) — has been 401-ing every
-- tick. Only the admin "Refresh routes" button (a user JWT, a different auth
-- path) still worked, so planned routes stopped auto-backfilling.
--
-- push/sync have no bearer gate so they were unaffected, but all three share
-- the one bearer var here — repoint them together for consistency and in case
-- either grows a gate later. The publishable key is client-exposed (not a
-- secret), same as the legacy anon it replaces.
--
-- cron.schedule(jobname, ...) upserts by name → idempotent re-apply.

DO $$
DECLARE
  v_base   text := 'https://tfddjmplcizfirxqhotv.supabase.co/functions/v1/';
  -- Publishable API key — routing bearer only, not a secret. Must match the
  -- SUPABASE_ANON_KEY the edge-function runtime injects (post new-key migration).
  v_bearer text := 'Bearer sb_publishable_IKPk11qLAiKp_-vbDF3Rug_VMhUh2dy';
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
