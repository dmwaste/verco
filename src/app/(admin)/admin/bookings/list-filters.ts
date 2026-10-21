import type { MultiSelectGroup } from '@/components/admin/filter-bar'

/**
 * URL handling for the bookings list's multi-select filters (VER-323).
 *
 * A multi-value filter is comma-joined in the query string
 * (`?status=Completed,Nothing Presented`). A single value — every existing deep
 * link (dashboard tile, stale-closeout alert, the detail page's back link) — is
 * simply the one-item case, so those links keep working unchanged.
 */

/** "a,b,,a" -> ["a", "b"]; null/empty -> []. */
export function parseMultiParam(value: string | null): string[] {
  if (!value) return []
  return [...new Set(value.split(',').map((v) => v.trim()).filter(Boolean))]
}

/** Keeps only values in `known`. A hand-edited URL with a stale enum value
 *  would otherwise make PostgREST reject the whole list query (400 → empty). */
export function onlyKnown<T extends string>(values: string[], known: readonly T[]): T[] {
  const allowed = new Set<string>(known)
  return values.filter((v): v is T => allowed.has(v))
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Keeps only uuid-shaped ids, for the same reason as `onlyKnown`. */
export function onlyUuids(values: string[]): string[] {
  return values.filter((v) => UUID.test(v))
}

export interface AreaFilterRow {
  id: string
  code: string
  sub_client: { name: string } | null
}

/**
 * Area options grouped by council (sub-client), so "CAM-A + CAM-B" or a whole
 * council is one tick. Returns null when the areas span fewer than two
 * councils — a single-council or council-less tenant gets a flat list.
 * Areas without a council sit in a trailing "Other areas" group.
 */
export function areaFilterGroups(areas: AreaFilterRow[]): MultiSelectGroup[] | null {
  const byCouncil = new Map<string, AreaFilterRow[]>()
  const unassigned: AreaFilterRow[] = []
  for (const a of areas) {
    if (!a.sub_client) {
      unassigned.push(a)
      continue
    }
    byCouncil.set(a.sub_client.name, [...(byCouncil.get(a.sub_client.name) ?? []), a])
  }
  if (byCouncil.size < 2) return null

  const toOptions = (rows: AreaFilterRow[]) =>
    [...rows].sort((x, y) => x.code.localeCompare(y.code)).map((r) => ({ value: r.id, label: r.code }))

  const groups: MultiSelectGroup[] = [...byCouncil.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([label, rows]) => ({ label, options: toOptions(rows) }))
  if (unassigned.length > 0) groups.push({ label: 'Other areas', options: toOptions(unassigned) })
  return groups
}
