-- Backfill investigation records for record-less exceptions.
--
-- An "exception" is a notice record (non_conformance_notice / nothing_presented),
-- raised per stop at field closeout. Legacy Airtable-imported bookings carry an
-- exception STATUS but never ran through closeout, so they have no record and are
-- invisible to the record-driven exception tables/badge/dashboard.
--
-- This closes that gap: insert a *Closed* record (terminal history — no one is
-- investigating a legacy import) for every exception-status booking that lacks one.
-- Set-based (not a hardcoded count) so it is correct + re-runnable after future
-- imports; the NOT EXISTS guard makes a re-run insert 0 rows. See spec
-- docs/superpowers/specs/2026-07-06-ncn-np-investigations-model-design.md.

-- NCN: reason is NOT NULL → 'Other'; reported_at = booking created_at (import time,
-- not updated_at which may reflect an unrelated later edit).
INSERT INTO non_conformance_notice
  (booking_id, client_id, reason, status, resolution_notes, reported_at, resolved_at)
SELECT b.id, b.client_id, 'Other'::ncn_reason, 'Closed'::ncn_status,
       'Imported from Airtable — status only (backfilled 2026-07)', b.created_at, now()
FROM booking b
WHERE b.status = 'Non-conformance'
  AND NOT EXISTS (
    SELECT 1 FROM non_conformance_notice n WHERE n.booking_id = b.id
  );

-- NP: no reason column.
INSERT INTO nothing_presented
  (booking_id, client_id, status, resolution_notes, reported_at, resolved_at)
SELECT b.id, b.client_id, 'Closed'::np_status,
       'Imported from Airtable — status only (backfilled 2026-07)', b.created_at, now()
FROM booking b
WHERE b.status = 'Nothing Presented'
  AND NOT EXISTS (
    SELECT 1 FROM nothing_presented n WHERE n.booking_id = b.id
  );
