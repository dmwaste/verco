#!/usr/bin/env bash
# Tags existing audit_log entries with their council (#614, ADR 0036).
#
# Migration 20261021023000 tags every NEW entry. This fills sub_client_id on the
# entries written before it, so council-scoped staff see their council's older
# history too. Run it ONCE, after that migration is live on prod, from a checkout
# linked to the prod project (`pnpm exec supabase link`):
#
#   bash scripts/backfill-audit-log-sub-client.sh                  # dry run: counts only
#   bash scripts/backfill-audit-log-sub-client.sh --apply          # writes
#   bash scripts/backfill-audit-log-sub-client.sh --apply --after <uuid>   # resume
#   BATCH=2000 bash scripts/backfill-audit-log-sub-client.sh --apply       # smaller batches
#
# Why a script and not a migration: db push runs each migration file in one
# transaction, so a migration can't commit between batches. One UPDATE over the
# ~420k Verge Valet entries would run for minutes inside the deploy, where a
# timeout aborts the release. Here each batch is its own short transaction:
#   - keyset on the primary key (id > last id, ORDER BY id, LIMIT n): no OFFSET
#     rescans, and each batch prints the id to resume from;
#   - only untagged entries of clients that have councils (Verge Valet today);
#     Kwinana has no councils and is never read for the tag;
#   - the tag comes from audit_log_sub_client_id(), the function the trigger
#     uses, so backfilled and new entries follow one rule;
#   - UPDATE takes ROW EXCLUSIVE on audit_log, which doesn't block the audit
#     trigger's INSERTs or any read, plus row locks on old entries nobody else
#     writes.
# Only NULL tags are written, so a re-run (or an overlap with the trigger) is a
# no-op. Untagged entries stay hidden from council staff, so stopping half-way
# fails closed: today's behaviour, never a leak.
#
# Run it out of hours (~85 batches, ~7 min on prod). Rewriting ~420k entries
# leaves the Audit Log page's index-only count reading the table until a vacuum
# has run (~6 s instead of ~0.2 s). Autovacuum picks it up on its own; to settle
# it at once, run `VACUUM (ANALYZE) public.audit_log;` in the dashboard SQL
# editor afterwards (this CLI wraps queries in a transaction, where VACUUM
# can't run).
set -euo pipefail

cd "$(dirname "$0")/.."

APPLY=false
AFTER='00000000-0000-0000-0000-000000000000'
BATCH="${BATCH:-5000}"

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=true ;;
    --after) AFTER="$2"; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

[[ "$AFTER" =~ ^[0-9a-f-]{36}$ ]] || { echo "--after must be a uuid" >&2; exit 2; }
[[ "$BATCH" =~ ^[0-9]+$ ]] || { echo "BATCH must be a number" >&2; exit 2; }

ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT

# Prints the query's last CSV row; on failure prints the CLI's error and fails.
query() {
  local out
  if ! out=$(pnpm exec supabase db query --linked --agent=no -o csv "$1" 2>"$ERR"); then
    grep -v '^WARN\|^Initialising\|new version\|recommend updating' "$ERR" >&2
    return 1
  fi
  printf '%s\n' "$out" | tail -1
}

# The column and the map function must be live before anything runs.
ready=$(query "SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.audit_log'::regclass AND attname = 'sub_client_id' AND NOT attisdropped")
if [ "$ready" != "1" ]; then
  echo "audit_log.sub_client_id isn't on this database yet: deploy migration 20261021023000 first." >&2
  exit 1
fi

if $APPLY; then
  write="UPDATE audit_log a SET sub_client_id = t.sub_client_id
           FROM tagged t
          WHERE a.id = t.id AND t.sub_client_id IS NOT NULL AND a.sub_client_id IS NULL
         RETURNING 1"
else
  write="SELECT 1 FROM tagged WHERE sub_client_id IS NOT NULL"
fi

echo "$($APPLY && echo Applying || echo 'Dry run (no writes)'): batches of $BATCH after $AFTER"
total_scanned=0
total_tagged=0
while :; do
  if ! row=$(query "
    WITH batch AS (
      SELECT id FROM audit_log
       WHERE id > '$AFTER'::uuid
         AND sub_client_id IS NULL
         AND client_id IN (SELECT client_id FROM sub_client)
       ORDER BY id
       LIMIT $BATCH
    ), tagged AS (
      SELECT a.id, audit_log_sub_client_id(a.table_name, COALESCE(a.new_data, a.old_data)) AS sub_client_id
        FROM audit_log a JOIN batch USING (id)
    ), written AS ($write)
    SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS last_id,
           (SELECT count(*) FROM batch) AS scanned,
           (SELECT count(*) FROM written) AS tagged"); then
    echo "Batch after $AFTER failed. Resume with: --after $AFTER" >&2
    exit 1
  fi
  IFS=, read -r last_id scanned tagged <<<"$row"
  [ "$scanned" -eq 0 ] && break
  total_scanned=$((total_scanned + scanned))
  total_tagged=$((total_tagged + tagged))
  echo "after $AFTER: scanned $scanned, $($APPLY && echo tagged || echo 'would tag') $tagged (running: $total_tagged / $total_scanned)"
  AFTER="$last_id"
done

echo "Done: $($APPLY && echo tagged || echo 'would tag') $total_tagged of $total_scanned untagged entries."
if $APPLY; then
  # Fresh stats on the new column, so council staff's reads plan on its index.
  query "ANALYZE public.audit_log" >/dev/null
  echo "Analysed audit_log. Entries left untagged, by table (by design: see the migration header):"
  pnpm exec supabase db query --linked --agent=no -o table "
    SELECT table_name, count(*) AS untagged
      FROM audit_log
     WHERE sub_client_id IS NULL AND client_id IN (SELECT client_id FROM sub_client)
     GROUP BY 1 ORDER BY 2 DESC" 2>/dev/null
fi
