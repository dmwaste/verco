-- =============================================================================
-- pg_cron schedule: send-collection-reminders
-- Runs at 01:00 UTC daily = 09:00 AWST
-- Invokes the send-collection-reminders EF which finds Confirmed bookings
-- whose earliest collection_date equals (today + client.sms_reminder_days_before)
-- and dispatches the reminder via send-notification. Tenants with NULL
-- sms_reminder_days_before opt out entirely.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-collection-reminders') THEN
    PERFORM cron.unschedule('send-collection-reminders');
  END IF;
END $$;

SELECT cron.schedule(
  'send-collection-reminders',
  '0 1 * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/send-collection-reminders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
