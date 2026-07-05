-- Verco → OptimoRoute completion sync (reverses the 2026-06-10 plan-only stance
-- for completion status only — crews still close out in Verco's field UI, not
-- the OR driver app).
--
-- Crews terminalise stops in Verco (Completed / Non-conformance / Nothing
-- Presented); OR never learns the order is done, so its route never advances
-- and its customer notifications (the "crew ~30 min away" ETA email +
-- completion receipt) can't run. This reports every terminal outcome back to OR
-- as a completed order (status='success') so OR can run its notification
-- lifecycle. Verco stays the source of truth for the real outcome — OR only
-- needs "done". Also a redundancy: OR's state mirrors reality.

-- Which terminal stops have already been reported complete to OR (mirrors the
-- pushed_at / routes_pulled_at pattern).
ALTER TABLE collection_stop
  ADD COLUMN IF NOT EXISTS completion_synced_at timestamptz;

-- Sweep the newly-terminal stops frequently: the ETA email is time-sensitive,
-- and a frequent idempotent sweep is its own fallback (a failed report just
-- retries next tick). The EF has no bearer gate (service-role work, like
-- push/sync), so the bearer is nominal — publishable key for consistency with
-- the other optimoroute crons. cron.schedule upserts by name → idempotent.
DO $$
DECLARE
  v_url    text := 'https://tfddjmplcizfirxqhotv.supabase.co/functions/v1/sync-completions-to-optimoroute';
  v_bearer text := 'Bearer sb_publishable_IKPk11qLAiKp_-vbDF3Rug_VMhUh2dy';
BEGIN
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
        body := '{}'::jsonb
      );
      $cmd$,
      v_url,
      v_bearer
    )
  );
END $$;
