-- #671 — a retried notification can't be sent twice; the admin MUD booking
-- path can record a confirmation it couldn't send.
--
-- 1. notification_log_send_claim_key — the dispatcher (_shared/dispatch.ts)
--    now CLAIMS a send before making it: it inserts the attempt's row as
--    'queued', sends, then settles that same row to 'sent' / 'failed'. This
--    partial unique index makes the claim atomic. At most one 'queued' (in
--    flight) or 'sent' row may exist per (booking, type, channel, reference),
--    so a retried EF→EF call (a 504 or the caller's 10 s abort can land after
--    the dispatcher started) hits 23505 and skips instead of sending again.
--    'failed' rows are outside the predicate, so a failure never blocks the
--    next attempt. Per-channel, as before: email and SMS claim separately.
--    reference_id is part of the key (ncn_id / np_id / correction_id …) so
--    per-notice types still notify once per notice; NULL is coalesced so
--    booking-level types (booking_created …) dedupe per booking.
--    Prod check 20/10/2026: zero existing duplicate keys among queued/sent
--    rows, and zero 'queued' rows at all, so the index builds as-is.
--    Readers: 'queued' already meant "about to send" (CHECK from 20260409),
--    nothing counts it as sent or failed; the watchdog now treats a booking
--    whose only booking_created row is a stranded 'queued' claim as
--    unconfirmed (notification-health-check), and a claim older than 10 min
--    is released by the next dispatch so a resend can go out.
--
-- 2. notification_log_staff_insert_failed — server actions run under the staff
--    member's own JWT (never the service role, Red Line #3), and until now no
--    app role could INSERT here. The MUD booking action's retrying invoker
--    (src/lib/notifications/invoke.ts → invokeBookingCreated) must leave a
--    'failed' booking_created row when send-notification is unreachable, so
--    the miss shows on /admin/notifications with a Retry button. Deliberately
--    narrow: staff roles only (never field/ranger/resident), status 'failed'
--    only (cannot forge a 'sent' row or take a send claim), booking_created
--    only, and only for a booking the caller can already see in a client they
--    can access — the booking lookup runs under the caller's own booking RLS,
--    which carries sub-client narrowing. Grants nothing new: the same staff
--    can already trigger that confirmation through send-notification.

CREATE UNIQUE INDEX IF NOT EXISTS notification_log_send_claim_key
  ON public.notification_log (
    booking_id,
    notification_type,
    channel,
    COALESCE(reference_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status IN ('queued', 'sent') AND booking_id IS NOT NULL;

COMMENT ON INDEX public.notification_log_send_claim_key IS
  'Send claim (#671): one queued-or-sent row per (booking, type, channel, reference). '
  'The dispatcher inserts its row as queued BEFORE sending; a 23505 here means another '
  'dispatch is sending or has sent, so it skips.';

DROP POLICY IF EXISTS notification_log_staff_insert_failed ON public.notification_log;
CREATE POLICY notification_log_staff_insert_failed ON public.notification_log
FOR INSERT WITH CHECK (
  status = 'failed'
  AND notification_type = 'booking_created'
  AND booking_id IS NOT NULL
  AND ((SELECT current_user_role()) = ANY (ARRAY['client-admin'::app_role, 'client-staff'::app_role, 'contractor-admin'::app_role, 'contractor-staff'::app_role]))
  AND client_id IN (SELECT accessible_client_ids())
  AND EXISTS (
    SELECT 1 FROM public.booking b
     WHERE b.id = notification_log.booking_id
       AND b.client_id = notification_log.client_id
  )
);
