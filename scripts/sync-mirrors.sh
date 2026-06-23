#!/usr/bin/env bash
# Syncs notification mirror files from supabase/functions/_shared/ to src/lib/notifications/.
#
# Deno requires explicit .ts extensions on imports; Node/TypeScript forbids them.
# These mirror files are byte-for-byte identical except for that difference.
# The _shared/ directory is the source of truth — always edit there.
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

drift=0
for f in "$SHARED/templates"/*.ts; do
  name="$(basename "$f")"
  sync_one "$f" "$MIRROR/templates/$name" || drift=1
done

sync_one "$SHARED/dispatch.ts" "$MIRROR/dispatch.ts" || drift=1
sync_one "$SHARED/notification-health.ts" "$MIRROR/health.ts" || drift=1
sync_one "$SHARED/schedule-transition.ts" "src/lib/booking/schedule-transition.ts" || drift=1
sync_one "$SHARED/stops.ts" "src/lib/stops/stops.ts" || drift=1
sync_one "$SHARED/expiry-decision.ts" "src/lib/payments/expiry-decision.ts" || drift=1
sync_one "$SHARED/area-gate-server.ts" "src/lib/booking/area-gate-server.ts" || drift=1
sync_one "$SHARED/terms.ts" "src/lib/booking/terms.ts" || drift=1

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
