-- notification_log delivery tracking — SendGrid Event Webhook (VER-188).
-- Adds a delivery lifecycle SEPARATE from `status` (queued|sent|failed). `status` is the
-- SEND result and is read by the re-send idempotency guard (send-notification: isAlreadySent
-- checks status='sent') — overwriting it with delivery events would silently re-trigger sends.
-- The `sendgrid-webhook` EF writes these columns instead.

ALTER TABLE notification_log
  ADD COLUMN IF NOT EXISTS delivery_status     text,
  ADD COLUMN IF NOT EXISTS delivery_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_detail     text;   -- bounce/drop reason when SendGrid provides one

-- Domain CHECK (nullable until SendGrid reports an event). Matches src/lib/notifications/sendgrid-events.ts.
ALTER TABLE notification_log
  DROP CONSTRAINT IF EXISTS notification_log_delivery_status_check;
ALTER TABLE notification_log
  ADD CONSTRAINT notification_log_delivery_status_check
  CHECK (delivery_status IS NULL OR delivery_status IN
    ('delivered', 'opened', 'deferred', 'bounced', 'dropped', 'spam'));

-- The webhook correlates a SendGrid event to the most-recent email row for that recipient.
CREATE INDEX IF NOT EXISTS idx_notification_log_to_address
  ON notification_log (to_address, created_at DESC)
  WHERE channel = 'email';

COMMENT ON COLUMN notification_log.delivery_status IS
  'SendGrid Event Webhook delivery state (delivered/opened/deferred/bounced/dropped/spam). Distinct from status (send result). VER-188.';
