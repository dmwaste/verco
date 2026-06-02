-- F5 (VER-247): Residents cannot cancel their own bookings.
--
-- Root cause: `booking_resident_update` (initial_schema) had a USING clause but
-- NO explicit WITH CHECK, so Postgres applied the USING expression as the WITH
-- CHECK. USING included `status NOT IN ('Scheduled','Completed','Cancelled')`,
-- so the NEW row's `status = 'Cancelled'` violated the implicit WITH CHECK and
-- the UPDATE was rejected — 0 rows changed, no error raised. The cancel server
-- action only checked the error (not rows-affected), so it returned a false
-- success and the UI silently did nothing. Staff cancel worked because
-- `booking_staff_update` carries no status predicate.
--
-- Fix: an explicit, tight policy. A resident may transition their OWN booking
-- from a pre-collection active status (Submitted/Confirmed) to Cancelled — and
-- to nothing else. Pending Payment is intentionally excluded (resident cancel
-- on Pending Payment is hidden in the UI / left to the expiry cron). The
-- cancellation-cutoff trigger and the state-machine trigger remain the timing
-- and validity backstops; this policy is purely the role/ownership gate.
--
--   resident UPDATE on booking:
--     USING      own booking, status ∈ {Submitted, Confirmed}   (which rows)
--     WITH CHECK own booking, status = Cancelled                 (allowed result)

DROP POLICY IF EXISTS booking_resident_update ON booking;

CREATE POLICY booking_resident_update ON booking FOR UPDATE
  USING (
    contact_id = current_user_contact_id()
    AND status IN ('Submitted', 'Confirmed')
  )
  WITH CHECK (
    contact_id = current_user_contact_id()
    AND status = 'Cancelled'
  );
