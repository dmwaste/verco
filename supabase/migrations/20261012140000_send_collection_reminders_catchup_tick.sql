-- Hotfix (WMRC, 12/10/2026): add a 09:20 AWST catch-up tick to the 3-day reminder job.
--
-- The 09:00 run was cut off by the 150 s edge gateway at ~150 bookings, so on
-- busy days 20–50% of residents never got their reminder. The EF now sends in
-- parallel within a time budget and returns 500 with `remaining` if it can't
-- finish; this second tick sends whatever the first left behind (or failed on).
-- Re-runs are safe: send-notification's (booking_id, type, channel) key skips
-- anything already sent, so nobody is reminded twice.
--
-- Rewrites the schedule in place (cron.schedule upserts by name) and keeps the
-- deployed command — URL, X-Cron-Secret header, timeout — byte-for-byte.
DO $$
DECLARE
  v_command text;
BEGIN
  SELECT command INTO v_command FROM cron.job WHERE jobname = 'send-collection-reminders';
  IF v_command IS NULL THEN
    RAISE EXCEPTION 'cron job send-collection-reminders not found — catch-up tick not added';
  END IF;
  PERFORM cron.schedule('send-collection-reminders', '0,20 1 * * *', v_command);
END $$;
