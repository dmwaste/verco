-- ============================================================
-- refund_request.review_notes — reject-justification capture
-- ============================================================
-- PR-A of the #405 two-PR split (migration ONLY). The consumer + the
-- regenerated types.ts land in PR-B, after this column reaches prod:
-- the Types-Freshness CI regenerates from prod, so shipping the column
-- and its consumer together would fail CI (prod lacks the column at
-- gen time). PR-A must be released to main before PR-B is opened.
--
-- Adds a nullable free-text column recording WHY a staff member
-- rejected a refund request. Every refund_request is auto-raised owed
-- money (there is no discretionary/resident path — see #404), so
-- rejecting one forfeits an owed refund permanently. The audit trigger
-- already records who/when; this captures the missing rationale.
--
-- No RLS change: refund_request_staff_update (20260605010000) already
-- authorises the staff UPDATE, and RLS is row-level so the new column
-- is covered. Existing rows keep review_notes NULL — reset-safe (pure
-- schema, no data dependency).
-- ============================================================

ALTER TABLE refund_request
  ADD COLUMN review_notes text;

COMMENT ON COLUMN refund_request.review_notes IS
  'Free-text staff justification captured when a refund request is rejected. NULL for pending/approved and legacy rows.';
