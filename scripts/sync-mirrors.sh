#!/usr/bin/env bash
# Syncs notification mirror files from supabase/functions/_shared/ to src/lib/notifications/.
#
# Deno requires explicit .ts extensions on imports; Node/TypeScript forbids them.
# These mirror files are byte-for-byte identical except for that difference.
# The _shared/ directory is the source of truth — always edit there.
#
# Usage: ./scripts/sync-mirrors.sh
# Run after any change to _shared/templates/ or _shared/dispatch.ts.
set -euo pipefail

SHARED="supabase/functions/_shared"
MIRROR="src/lib/notifications"

sync_file() {
  local src="$1"
  local dst="$2"
  # Rewrite '.ts' import extensions to extensionless
  sed "s/from '\(\.\/[^']*\)\.ts'/from '\1'/g;s/from '\(\.\.\\/[^']*\)\.ts'/from '\1'/g" "$src" > "$dst"
  echo "synced: $src -> $dst"
}

for f in "$SHARED/templates"/*.ts; do
  name="$(basename "$f")"
  sync_file "$f" "$MIRROR/templates/$name"
done

sync_file "$SHARED/dispatch.ts" "$MIRROR/dispatch.ts"

echo "Mirror sync complete."
