-- send-routes-to-optimoroute: share tomorrow's routes with the crews at 20:00 AWST.
--
-- The 8pm route handover was manual: ops pressed "Share routes" in the
-- OptimoRoute web UI, or scheduled the share ahead. A scheduled share freezes
-- the routes as they were when it was scheduled, so on 12/10/2026 the crews
-- got Friday afternoon's plan for Monday — MOS-12984, moved off the 12th on
-- Saturday evening (and deleted from OptimoRoute 38 minutes later), was still
-- on VV3's phone route, along with three other stops cancelled over the
-- weekend. Verco now does the share itself, from the live plan, once a night.
-- Changes after 8pm stay manual (staff re-share in OR). ADR 0028.
--
-- 12:00 UTC = 20:00 AWST (WA has no daylight saving). After the 19:10 push
-- and 19:20 cancellation sweep; the EF sweeps once more itself before sending.
--
-- The command is copied from sync-optimoroute-cancellations with only the
-- function slug swapped, so the URL base, routing bearer, Vault X-Cron-Secret
-- header (20260822090000) and pg_net timeout (20260713100000) are identical.
-- cron.schedule upserts by name, so this is re-appliable.
DO $$
DECLARE
  v_src text;
  v_cmd text;
BEGIN
  SELECT command INTO v_src FROM cron.job WHERE jobname = 'sync-optimoroute-cancellations';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'sync-optimoroute-cancellations is not scheduled — no command to derive the 8pm send from';
  END IF;

  IF v_src NOT LIKE '%X-Cron-Secret%' THEN
    RAISE EXCEPTION
      'sync-optimoroute-cancellations command has no X-Cron-Secret header — refusing to copy it (see 20260822090000)';
  END IF;

  v_cmd := replace(
    v_src,
    '/functions/v1/sync-optimoroute-cancellations',
    '/functions/v1/send-routes-to-optimoroute'
  );

  IF v_cmd = v_src THEN
    RAISE EXCEPTION 'sync-optimoroute-cancellations command has an unexpected URL shape — 8pm send not scheduled';
  END IF;

  PERFORM cron.schedule('send-routes-to-optimoroute', '0 12 * * *', v_cmd);
END $$;
