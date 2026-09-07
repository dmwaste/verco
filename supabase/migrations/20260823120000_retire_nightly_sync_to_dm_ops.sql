-- =============================================================================
-- Retire the nightly DM-Ops sync — unschedule the cron (ADR 0015).
--
-- The job has fired at 03:00 AWST every night since 27/03 and the EF has never
-- completed a single run: the DM_OPS_* secrets were never configured, and the
-- DM-Ops booked_collection table's real schema (per-service columns keyed by
-- job/area) no longer matches the aggregate payload the EF sends. DM-Ops gets
-- these stats another way, so the sync is retired rather than redesigned
-- (Dan, 23/08/2026). The Edge Function stays deployed but dormant; reviving it
-- needs a redesigned payload + secrets + a new scheduling migration.
--
-- Idempotent: no-ops when the job is already gone (it was also unscheduled
-- directly on prod on 23/08 so the nightly Sentry alerts stopped immediately).
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'nightly-sync-to-dm-ops') THEN
    PERFORM cron.unschedule('nightly-sync-to-dm-ops');
  END IF;
END $$;
