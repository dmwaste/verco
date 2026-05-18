-- =============================================================================
-- Twilio SMS Phase 1 — per-tenant Messaging Service SID + reminder config
--
-- Adds `client.twilio_messaging_service_sid` (the `MG…` per-tenant alpha
-- sender pool ID). The dispatcher reads this on every notification; NULL
-- skips the SMS channel for that tenant.
--
-- Backfills:
--   - Verco Kwinana (slug=kwn)          → MG3247a987de2cd0b550904b7973305780
--   - Verge Valet  (slug=vergevalet)    → MG44a9c63be9380fcafc23a1f1efe86733
--                  sms_sender_id        = 'VergeValet'
--                  sms_reminder_days_before = 2 (only if currently NULL)
--
-- `sms_sender_id` is legacy/cosmetic from initial_schema — kept populated for
-- audit visibility, but the dispatcher uses the MG SID for routing.
-- =============================================================================

ALTER TABLE client
  ADD COLUMN IF NOT EXISTS twilio_messaging_service_sid text;

COMMENT ON COLUMN client.twilio_messaging_service_sid IS
  'Twilio Messaging Service SID (MG…). NULL = no SMS for this tenant.';

UPDATE client
SET twilio_messaging_service_sid = 'MG3247a987de2cd0b550904b7973305780'
WHERE slug = 'kwn'
  AND twilio_messaging_service_sid IS NULL;

UPDATE client
SET twilio_messaging_service_sid = 'MG44a9c63be9380fcafc23a1f1efe86733',
    sms_sender_id = COALESCE(sms_sender_id, 'VergeValet'),
    sms_reminder_days_before = COALESCE(sms_reminder_days_before, 2)
WHERE slug = 'vergevalet'
  AND twilio_messaging_service_sid IS NULL;
