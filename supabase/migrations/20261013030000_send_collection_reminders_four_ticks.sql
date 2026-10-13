-- Reminders (WMRC, 13/10/2026): run the 3-day reminder job at 09:00, 09:10,
-- 09:20 and 09:30 AWST (was 09:00 + 09:20).
--
-- The EF calls send-notification once per booking, and Supabase rate-limits one
-- edge function calling another (~60 calls per window). On 13/10 both ticks
-- stopped at 60 and 7 residents got nothing. The EF now pauses on the limit
-- and skips bookings already reminded, so each tick clears ~120 — four ticks
-- cover a ~480-booking day (busiest coming day: 243 on Sat 17/10).
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
    RAISE EXCEPTION 'cron job send-collection-reminders not found — extra ticks not added';
  END IF;
  PERFORM cron.schedule('send-collection-reminders', '0,10,20,30 1 * * *', v_command);
END $$;
