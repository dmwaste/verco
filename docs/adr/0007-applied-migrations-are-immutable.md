# 0007 — A database change already applied to production is never edited — new changes get a new file

- **Date:** 12/07/2026
- **Status:** Accepted

## Decision

Once a migration file (a scripted database change) has been applied to production, it is frozen — never edited again, not even to add a comment. Any further change, however small, goes in a new migration file with a new version number.

## Why

The deploy tool matches migrations to the production database by version number and silently skips any it has already applied. So an edit to an applied file *looks* like it shipped but never reaches production — the code in the repo and the real database quietly stop matching, which is the most dangerous kind of bug because nothing fails visibly. This was caught live during the 12/07/2026 pre-release review: a session had edited an already-applied migration on the refund concurrency guard, and following its edited instructions would have left production error-handling silently different from what the repo claimed (fixed in PR #418 by restoring the applied file byte-for-byte).
