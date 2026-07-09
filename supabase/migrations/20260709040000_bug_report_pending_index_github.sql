-- bug_report pending-queue index: retarget from Linear to the GitHub lane.
--
-- idx_bug_report_linear_pending indexed the "untriaged, not yet in Linear" queue
-- (status='new' AND linear_issue_id IS NULL). The bug-report-triage routine now
-- files to GitHub (migration 20260709020000), so the pending predicate is
-- github_issue_number IS NULL. Drop the now-stale index and replace it with the
-- GitHub equivalent so the pending-queue predicate stays honest. bug_report is a
-- tiny table, so this is intent/correctness hygiene, not a performance need.

DROP INDEX IF EXISTS public.idx_bug_report_linear_pending;

CREATE INDEX IF NOT EXISTS idx_bug_report_github_pending
  ON public.bug_report (created_at)
  WHERE status = 'new' AND github_issue_number IS NULL;
