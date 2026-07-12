#!/usr/bin/env bash
# Syncs notification mirror files from supabase/functions/_shared/ to src/lib/notifications/.
#
# Deno requires explicit .ts extensions on imports; Node/TypeScript forbids them.
# These mirror files are byte-for-byte identical except for that difference.
# The _shared/ directory is the source of truth — always edit there.
#
# ONE pair runs the OTHER direction: supabase/functions/_shared/database.types.ts is a
# generated copy of src/lib/supabase/types.ts (the source of truth is the GENERATED node
# file). It exists so Deno Edge Functions can import the `Database` generic — Deno can't
# resolve the Node "@/lib/supabase/types" alias, and a cross-boundary import into src/ does
# not survive `supabase functions deploy`'s per-function bundle. See sync_db_types below.
#
# Usage:
#   ./scripts/sync-mirrors.sh           # write mode (default) — regenerates mirrors
#   ./scripts/sync-mirrors.sh --check   # read-only — exits 1 if any mirror has drifted
#
# Run write mode after any change to _shared/templates/, _shared/dispatch.ts, or
# _shared/schedule-transition.ts. The --check mode is what the pre-push hook
# (scripts/git-hooks/pre-push) invokes to block accidental drift.
set -euo pipefail

SHARED="supabase/functions/_shared"
MIRROR="src/lib/notifications"

mode="write"
if [ "${1:-}" = "--check" ]; then
  mode="check"
elif [ -n "${1:-}" ]; then
  echo "Unknown argument: $1" >&2
  echo "Usage: $0 [--check]" >&2
  exit 2
fi

# Generate the would-be content for a single mirror file.
# Rewrites Deno-style '.ts' import extensions to extensionless.
generate() {
  local src="$1"
  sed "s/from '\(\.\/[^']*\)\.ts'/from '\1'/g;s/from '\(\.\.\\/[^']*\)\.ts'/from '\1'/g" "$src"
}

# Sync (write) or check a single src → dst pair. Returns 0 if in sync, 1 if drifted.
sync_one() {
  local src="$1"
  local dst="$2"
  if [ "$mode" = "check" ]; then
    if [ ! -f "$dst" ]; then
      echo "DRIFT: $dst is missing"
      return 1
    fi
    if ! generate "$src" | diff -q - "$dst" > /dev/null 2>&1; then
      echo "DRIFT: $dst is out of sync with $src"
      return 1
    fi
    return 0
  else
    generate "$src" > "$dst"
    echo "synced: $src -> $dst"
    return 0
  fi
}

# Deno-importable copy of the generated Supabase Database types. Unlike the mirrors
# above, the SOURCE here is the generated node file (src/lib/supabase/types.ts) and the
# DESTINATION is under _shared/. A fixed banner is prepended so the file self-documents;
# the check mode regenerates banner+source and diffs, so it can never silently drift.
DB_TYPES_SRC="src/lib/supabase/types.ts"
DB_TYPES_DST="$SHARED/database.types.ts"

gen_db_types() {
  cat <<'BANNER'
// ⚠️  GENERATED FILE — DO NOT EDIT BY HAND.
// Byte-for-byte copy of src/lib/supabase/types.ts (below this banner), produced by
// scripts/sync-mirrors.sh so Deno Edge Functions can import the `Database` generic.
// Deno can't resolve the Node "@/lib/supabase/types" alias, and a relative import into
// src/ does not survive `supabase functions deploy`'s per-function bundle — so the types
// are copied inside supabase/functions/_shared/ where the bundler can always reach them.
// Regenerate: pnpm supabase gen types … > src/lib/supabase/types.ts && bash scripts/sync-mirrors.sh
BANNER
  cat "$DB_TYPES_SRC"
}

# Sync (write) or check the generated Database-types copy. Returns 0 if in sync, 1 if drifted.
sync_db_types() {
  if [ "$mode" = "check" ]; then
    if [ ! -f "$DB_TYPES_DST" ]; then
      echo "DRIFT: $DB_TYPES_DST is missing"
      return 1
    fi
    if ! gen_db_types | diff -q - "$DB_TYPES_DST" > /dev/null 2>&1; then
      echo "DRIFT: $DB_TYPES_DST is out of sync with $DB_TYPES_SRC"
      return 1
    fi
    return 0
  else
    gen_db_types > "$DB_TYPES_DST"
    echo "synced: $DB_TYPES_SRC -> $DB_TYPES_DST"
    return 0
  fi
}

drift=0
sync_db_types || drift=1
for f in "$SHARED/templates"/*.ts; do
  name="$(basename "$f")"
  sync_one "$f" "$MIRROR/templates/$name" || drift=1
done

sync_one "$SHARED/dispatch.ts" "$MIRROR/dispatch.ts" || drift=1
sync_one "$SHARED/notification-authz.ts" "$MIRROR/authz.ts" || drift=1
sync_one "$SHARED/notification-health.ts" "$MIRROR/health.ts" || drift=1
sync_one "$SHARED/schedule-transition.ts" "src/lib/booking/schedule-transition.ts" || drift=1
sync_one "$SHARED/stops.ts" "src/lib/stops/stops.ts" || drift=1
sync_one "$SHARED/expiry-decision.ts" "src/lib/payments/expiry-decision.ts" || drift=1
sync_one "$SHARED/area-gate-server.ts" "src/lib/booking/area-gate-server.ts" || drift=1
sync_one "$SHARED/terms.ts" "src/lib/booking/terms.ts" || drift=1
sync_one "$SHARED/classify-creator.ts" "src/lib/bookings/classify-creator.ts" || drift=1
sync_one "$SHARED/cancellation-cutoff.ts" "src/lib/booking/cancellation-cutoff.ts" || drift=1
sync_one "$SHARED/edit-guard.ts" "src/lib/booking/edit-guard.ts" || drift=1
sync_one "$SHARED/refund-allocation.ts" "src/lib/payments/refund-allocation.ts" || drift=1
sync_one "$SHARED/quantity-edit-decision.ts" "src/lib/booking/quantity-edit-decision.ts" || drift=1
sync_one "$SHARED/edit-error-mapping.ts" "src/lib/booking/edit-error-mapping.ts" || drift=1
sync_one "$SHARED/refund-auto-approve.ts" "src/lib/payments/refund-auto-approve.ts" || drift=1

if [ "$mode" = "check" ]; then
  if [ "$drift" -eq 1 ]; then
    echo ""
    echo "One or more notification/schedule-transition mirrors have drifted."
    echo "Fix: bash scripts/sync-mirrors.sh   (writes the regenerated mirrors)"
    exit 1
  fi
  echo "All mirrors in sync."
else
  echo "Mirror sync complete."
fi
