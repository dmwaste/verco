-- ---------------------------------------------------------------------------
-- Fixes from the PR-B field-consumers review (10/06/2026):
--
-- 1. Drop the legacy booking_survey_on_completion trigger. It ran as the
--    invoking role (not SECURITY DEFINER) and its INSERT into booking_survey
--    violated RLS (the table has no INSERT policy), aborting the very
--    booking UPDATE it was attached to with 42501. Verified live: zero
--    bookings have EVER reached Completed in prod — every field closeout
--    (legacy completeBooking AND the new final-stop rollup, which updates
--    booking as the field user) would fail at this trigger. The application
--    owns survey creation (it needs the token to send the notification);
--    the trigger's random-token row would have suppressed the email anyway.
--
-- 2. booking_survey INSERT policy for field-tier users — the closeout
--    actions (legacy completeBooking, new completeStop) insert the survey
--    row under the crew's session.
--
-- 3. notification_log.reference_id — per-notice idempotency for
--    ncn_raised / np_raised. The stop model legitimately raises multiple
--    same-type notices per booking (one per waste stream); the old
--    (booking_id, type, channel) key silently suppressed every notice after
--    the first, running its 14-day dispute window without the resident ever
--    being told.
--
-- 4. Field DELETE policies on NCN/NP, scoped to the reporter's own Issued
--    notices — compensation path for the closeout race: when two crews
--    close the same stop near-simultaneously, the loser's already-inserted
--    notice must be removed or an admin could rebook the same stream twice.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS booking_survey_on_completion ON booking;
DROP FUNCTION IF EXISTS create_survey_on_completion();

CREATE POLICY booking_survey_field_insert ON booking_survey FOR INSERT
  WITH CHECK (
    is_field_user()
    AND client_id IN (SELECT accessible_client_ids())
    AND booking_id IN (SELECT id FROM booking)
  );

ALTER TABLE notification_log ADD COLUMN reference_id uuid;
COMMENT ON COLUMN notification_log.reference_id IS
  'Per-notice idempotency discriminator (ncn_id / np_id). NULL for types '
  'keyed per booking. ncn_raised/np_raised dedupe on (booking_id, type, '
  'channel, reference_id) so each per-stream notice notifies independently.';

CREATE POLICY ncn_field_delete_own_issued ON non_conformance_notice FOR DELETE
  USING (
    has_role('field'::app_role)
    AND reported_by = auth.uid()
    AND status = 'Issued'::ncn_status
  );

CREATE POLICY np_field_delete_own_issued ON nothing_presented FOR DELETE
  USING (
    has_role('field'::app_role)
    AND reported_by = auth.uid()
    AND status = 'Issued'::np_status
  );
