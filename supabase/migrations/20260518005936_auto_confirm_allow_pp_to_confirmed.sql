-- Auto-confirm on submission — Option B.
--
-- Drops the manual Submitted → Confirmed gate by sending bookings straight
-- to Confirmed when they're created (free path) or paid (paid path). This
-- matches Dan's mental model: a resident getting the booking_created email
-- means the booking is accepted, not "awaiting staff review".
--
-- This migration only adjusts the enforce-transition matrix. The Submitted
-- state stays in the enum and the existing Submitted → Confirmed line stays
-- as a safety net — any rare booking that lands in Submitted (legacy /
-- manual SQL / future re-introduced gate) can still be moved forward by
-- the admin Confirm button.
--
-- The paid path (stripe-webhook) needs a new allowed transition:
--   Pending Payment → Confirmed
-- The free path (create-booking EF) inserts directly with status='Confirmed'
-- which bypasses this BEFORE-UPDATE trigger entirely.

CREATE OR REPLACE FUNCTION enforce_booking_state_transition()
RETURNS TRIGGER AS $$
DECLARE
  valid boolean := false;
BEGIN
  valid := CASE
    WHEN OLD.status = 'Pending Payment'   AND NEW.status = 'Submitted'          THEN true
    WHEN OLD.status = 'Pending Payment'   AND NEW.status = 'Confirmed'          THEN true
    WHEN OLD.status = 'Pending Payment'   AND NEW.status = 'Cancelled'          THEN true
    WHEN OLD.status = 'Submitted'         AND NEW.status = 'Confirmed'          THEN true
    WHEN OLD.status = 'Submitted'         AND NEW.status = 'Cancelled'          THEN true
    WHEN OLD.status = 'Confirmed'         AND NEW.status = 'Scheduled'          THEN true
    WHEN OLD.status = 'Confirmed'         AND NEW.status = 'Cancelled'          THEN true
    WHEN OLD.status = 'Scheduled'         AND NEW.status = 'Completed'          THEN true
    WHEN OLD.status = 'Scheduled'         AND NEW.status = 'Non-conformance'    THEN true
    WHEN OLD.status = 'Scheduled'         AND NEW.status = 'Nothing Presented'  THEN true
    WHEN OLD.status = 'Scheduled'         AND NEW.status = 'Cancelled'          THEN true
    WHEN OLD.status = 'Non-conformance'   AND NEW.status = 'Rebooked'           THEN true
    WHEN OLD.status = 'Nothing Presented' AND NEW.status = 'Rebooked'           THEN true
    ELSE false
  END;

  IF NOT valid THEN
    RAISE EXCEPTION 'Invalid booking status transition: % → %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- One-time backfill: bookings already sitting in Submitted (3 in prod at
-- migration time) move to Confirmed so the live UAT bookings reflect the
-- new model. The Submitted → Confirmed transition is allowed so this is
-- just an UPDATE that fires the existing audit trigger.
--
-- We deliberately do NOT re-fire booking_created — the resident already
-- received that email when the booking was originally submitted.
UPDATE booking SET status = 'Confirmed' WHERE status = 'Submitted';
