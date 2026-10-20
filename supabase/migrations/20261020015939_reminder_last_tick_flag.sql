-- Reminders (20/10/2026, ADR 0032): the cron tells send-collection-reminders
-- which tick is the last of the morning, instead of the EF guessing from a
-- hard-coded 09:30 AWST in code.
--
-- Only the last tick may raise a 500 (a miss nobody will retry); earlier ticks
-- hand unfinished work on with a 207. The EF treats a run WITHOUT the flag as
-- the last tick, so a tick added later without it alerts rather than hides.
--
--   send-collection-reminders       09:00, 09:10, 09:20 AWST  body {"last_tick": false}
--   send-collection-reminders-last  09:30 AWST                body {"last_tick": true}
--
-- Built from the deployed command, so URL, X-Cron-Secret header and timeout
-- stay byte-for-byte; only the body differs. Re-runnable: cron.schedule
-- upserts by name and the body pattern matches either form.
DO $$
DECLARE
  v_command text;
  v_body_re constant text := 'body := ''[^'']*''::jsonb';
BEGIN
  SELECT command INTO v_command FROM cron.job WHERE jobname = 'send-collection-reminders';
  IF v_command IS NULL THEN
    RAISE EXCEPTION 'cron job send-collection-reminders not found — last-tick flag not added';
  END IF;
  IF v_command !~ v_body_re THEN
    RAISE EXCEPTION 'send-collection-reminders command has no body := ''…''::jsonb — last-tick flag not added';
  END IF;

  PERFORM cron.schedule(
    'send-collection-reminders',
    '0,10,20 1 * * *',
    regexp_replace(v_command, v_body_re, 'body := ''{"last_tick": false}''::jsonb')
  );
  PERFORM cron.schedule(
    'send-collection-reminders-last',
    '30 1 * * *',
    regexp_replace(v_command, v_body_re, 'body := ''{"last_tick": true}''::jsonb')
  );
END $$;
