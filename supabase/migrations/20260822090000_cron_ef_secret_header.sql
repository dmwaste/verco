-- #517: cron → Edge Function calls carry an X-Cron-Secret header.
--
-- Every EF deploys --no-verify-jwt, and the cron EFs had no in-function gate:
-- anyone with the URL could trigger them. pg_cron can't send the service-role
-- key (no GUC/secret access from SQL — see 20260603000000), so it sends the
-- PUBLIC anon/publishable key as a routing bearer, which proves nothing.
--
-- Fix: a shared secret. Stored ONCE in Supabase Vault (name `cron_ef_secret`)
-- and ONCE as the EF secret `CRON_SECRET` — same value, never in git. pg_cron
-- reads it at run time from vault.decrypted_secrets (the job runs as postgres,
-- which can decrypt); the EF (`_shared/cron-handler.ts`) compares it to its env.
--
-- Rewrites each EF-invoking job's command in place — only the headers object
-- changes — via cron.schedule (upserts by name, idempotent). Skips jobs that
-- already send the header. COALESCE('') keeps a fresh `db reset` (no Vault
-- row) from erroring; the EF then rejects — loudly, via Sentry — until the
-- secret is provisioned. close-imminent-dates is pure SQL and untouched.
DO $$
DECLARE
  v_job record;
  v_new text;
BEGIN
  FOR v_job IN
    SELECT jobname, schedule, command
      FROM cron.job
     WHERE command LIKE '%/functions/v1/%'
       AND command NOT LIKE '%X-Cron-Secret%'
  LOOP
    v_new := replace(
      v_job.command,
      'jsonb_build_object(''Authorization''',
      'jsonb_build_object(''X-Cron-Secret'', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''cron_ef_secret'' LIMIT 1), ''''), ''Authorization'''
    );
    IF v_new = v_job.command THEN
      RAISE EXCEPTION 'cron job % has an unexpected command shape — header not injected', v_job.jobname;
    END IF;
    PERFORM cron.schedule(v_job.jobname, v_job.schedule, v_new);
  END LOOP;
END $$;
