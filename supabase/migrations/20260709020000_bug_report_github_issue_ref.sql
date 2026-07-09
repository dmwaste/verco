-- bug_report GitHub-issue back-reference — align the bug-report-triage routine
-- with the GitHub Issues bug lane.
--
-- The bug-report-triage routine now files triaged in-product bug reports as
-- GitHub issues on dmwaste/verco (previously Linear). Give bug_report a native
-- place to store the resulting issue so the admin bug-reports UI can deep-link
-- to it. The legacy linear_issue_id / linear_issue_url columns are KEPT — they
-- hold the back-references for reports triaged during UAT; the admin UI (PR-B)
-- prefers the GitHub link and falls back to Linear for those historical rows.
--
-- Additive + nullable; no backfill. RLS is row-level, so the existing bug_report
-- UPDATE policy already covers these new columns (the routine writes them under
-- the same policy it uses to flip status -> 'triaged'). The table's audit
-- trigger picks up the new columns automatically.

ALTER TABLE public.bug_report
  ADD COLUMN IF NOT EXISTS github_issue_number integer,
  ADD COLUMN IF NOT EXISTS github_issue_url    text;

COMMENT ON COLUMN public.bug_report.github_issue_number IS
  'GitHub issue number on dmwaste/verco filed by the bug-report-triage routine (null until triaged).';
COMMENT ON COLUMN public.bug_report.github_issue_url IS
  'Full URL of the GitHub issue filed by the bug-report-triage routine (null until triaged).';
