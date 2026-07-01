import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { FIELD_LABELS, NOISE_FIELDS, FK_RESOLVE_MAP } from './field-labels'
import { format } from 'date-fns'

type Json = Database['public']['Tables']['audit_log']['Row']['old_data']

// ── Public types ────────────────────────────────────────────

export interface AuditChange {
  field: string   // Human label e.g. "Status"
  oldValue: string | null
  newValue: string | null
}

export interface ResolvedAuditEntry {
  id: string
  action: string          // "INSERT" | "UPDATE" | "DELETE"
  tableName: string       // Raw table name for grouping
  summary: string         // "Status changed to Confirmed"
  actorName: string | null
  createdAt: string       // ISO timestamp
  changes: AuditChange[]
}

interface ChildSpec {
  table: string
  fkColumn: string
  /** The value to match on fkColumn (defaults to the parent recordId) */
  fkValue?: string
}

interface ResolveOptions {
  includeChildren?: ChildSpec[]
  limit?: number
}

// ── Entry point ─────────────────────────────────────────────

export async function resolveAuditLogs(
  supabase: SupabaseClient<Database>,
  tableName: string,
  recordId: string,
  options?: ResolveOptions,
): Promise<ResolvedAuditEntry[]> {
  const limit = options?.limit ?? 50

  // 1. Fetch audit entries for the main record
  const { data: mainEntries } = await supabase
    .from('audit_log')
    .select('id, table_name, action, old_data, new_data, changed_by, created_at')
    .eq('table_name', tableName)
    .eq('record_id', recordId)
    .order('created_at', { ascending: false })
    .limit(limit)

  let allEntries = mainEntries ?? []

  // 2. Fetch audit entries for child records
  if (options?.includeChildren) {
    for (const child of options.includeChildren) {
      // For child tables, we need to find all record_ids that belong to this parent
      // by querying the child table for rows matching the FK
      const fkValue = child.fkValue ?? recordId
      const { data: childRows } = await supabase
        .from(child.table as keyof Database['public']['Tables'])
        .select('id')
        .eq(child.fkColumn, fkValue) as { data: { id: string }[] | null }

      if (childRows && childRows.length > 0) {
        const childIds = childRows.map((r) => r.id)
        const { data: childEntries } = await supabase
          .from('audit_log')
          .select('id, table_name, action, old_data, new_data, changed_by, created_at')
          .eq('table_name', child.table)
          .in('record_id', childIds)
          .order('created_at', { ascending: false })
          .limit(limit)

        if (childEntries) {
          allEntries = [...allEntries, ...childEntries]
        }
      }
    }
  }

  // Sort all entries by created_at descending
  allEntries.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  // 3. Resolve actor names
  const actorIds = [...new Set(allEntries.map((e) => e.changed_by).filter(Boolean))] as string[]
  const actorMap = await resolveActorNames(supabase, actorIds)

  // 4. Collect all FK UUIDs that need resolution
  const fkUuids = collectFkUuids(allEntries)
  const fkLabelMap = await resolveFkLabels(supabase, fkUuids)

  // 5. Build resolved entries
  return allEntries.map((entry) => {
    const changes = diffData(entry.old_data as Record<string, unknown> | null, entry.new_data as Record<string, unknown> | null, fkLabelMap)
    const summary = generateSummary(entry.action, entry.table_name, changes)

    return {
      id: entry.id,
      action: entry.action,
      tableName: entry.table_name,
      summary,
      actorName: entry.changed_by ? (actorMap[entry.changed_by] ?? null) : null,
      createdAt: entry.created_at,
      changes,
    }
  })
}

// ── Actor name resolution ───────────────────────────────────

/**
 * Resolve a set of `auth.uid` UUIDs to display names for the audit timeline.
 *
 * Delegates to the `resolve_actor_names` SECURITY DEFINER RPC
 * (migration 20260701030000). The name lives in `profiles.display_name`
 * or, for the common case where that's NULL, `contacts.full_name` via
 * `profiles.contact_id`. That traversal CANNOT be done under the viewer's
 * RLS: for a resident actor, `profiles_staff_select` hides the profiles row
 * from staff (so staff can't enumerate residents), so a direct
 * profiles → contacts read returns nothing and every resident-created
 * booking showed "System". The definer RPC bypasses that one blocked hop
 * and is itself staff-role gated, so field / ranger / resident callers get
 * nothing — the PII rule is preserved (CLAUDE.md §4/§20).
 *
 * Both admin surfaces (this timeline + the global audit-log page) share
 * this resolver, so both are fixed at once.
 *
 * NOTE: `resolve_actor_names` is not yet in the generated Supabase types
 * (single-PR + typed-cast per the ghost-release convention — types regen
 * lands in a follow-up once the migration is on prod). The `as never` casts
 * satisfy the rpc overload until then.
 */
export async function resolveActorNames(
  supabase: SupabaseClient<Database>,
  userIds: string[],
): Promise<Record<string, string>> {
  if (userIds.length === 0) return {}

  const { data } = (await supabase.rpc(
    'resolve_actor_names' as never,
    { p_user_ids: userIds } as never,
  )) as { data: Array<{ user_id: string; name: string | null }> | null }

  const map: Record<string, string> = {}
  for (const row of data ?? []) {
    if (row.name) map[row.user_id] = row.name
  }
  return map
}

// ── FK UUID collection ──────────────────────────────────────

/** Collect all unique UUIDs per FK column across all entries */
export function collectFkUuids(
  entries: Array<{ old_data: Json; new_data: Json }>,
): Record<string, Set<string>> {
  const result: Record<string, Set<string>> = {}

  for (const entry of entries) {
    for (const data of [entry.old_data, entry.new_data]) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      const record = data as Record<string, unknown>
      for (const [col, val] of Object.entries(record)) {
        if (col in FK_RESOLVE_MAP && typeof val === 'string' && isUuid(val)) {
          if (!result[col]) result[col] = new Set()
          result[col].add(val)
        }
      }
    }
  }
  return result
}

/** Batch-resolve FK UUIDs to display labels */
export async function resolveFkLabels(
  supabase: SupabaseClient<Database>,
  fkUuids: Record<string, Set<string>>,
): Promise<Record<string, string>> {
  const labelMap: Record<string, string> = {}

  for (const [col, uuids] of Object.entries(fkUuids)) {
    const spec = FK_RESOLVE_MAP[col]
    if (!spec || uuids.size === 0) continue

    const ids = [...uuids]
    const { data } = await supabase
      .from(spec.table as keyof Database['public']['Tables'])
      .select(`id, ${spec.column}`)
      .in('id', ids) as { data: Array<Record<string, unknown>> | null }

    if (data) {
      for (const row of data) {
        const id = row.id as string
        const label = row[spec.column]
        if (label != null) {
          labelMap[id] = String(label)
        }
      }
    }
  }

  return labelMap
}

// ── Diff computation ────────────────────────────────────────

export function diffData(
  oldData: Record<string, unknown> | null,
  newData: Record<string, unknown> | null,
  fkLabelMap: Record<string, string>,
): AuditChange[] {
  const changes: AuditChange[] = []

  if (!oldData && newData) {
    // INSERT — show only fields that actually carry a value. We used to
    // emit a row for every non-noise column, which rendered a long list
    // of "Notes: —", "Latitude: —", etc. on freshly-created bookings/
    // service items. Residents in UAT read that as broken data. A null
    // on creation just means the column wasn't set yet, so we hide it.
    for (const [col, val] of Object.entries(newData)) {
      if (NOISE_FIELDS.has(col)) continue
      if (val === null || val === undefined || val === '') continue
      changes.push({
        field: FIELD_LABELS[col] ?? col,
        oldValue: null,
        newValue: formatValue(col, val, fkLabelMap),
      })
    }
    return changes
  }

  if (oldData && !newData) {
    // DELETE — show only fields that actually carried a value.
    for (const [col, val] of Object.entries(oldData)) {
      if (NOISE_FIELDS.has(col)) continue
      if (val === null || val === undefined || val === '') continue
      changes.push({
        field: FIELD_LABELS[col] ?? col,
        oldValue: formatValue(col, val, fkLabelMap),
        newValue: null,
      })
    }
    return changes
  }

  if (!oldData || !newData) return changes

  // UPDATE — show changed fields only
  const allCols = new Set([...Object.keys(oldData), ...Object.keys(newData)])
  for (const col of allCols) {
    if (NOISE_FIELDS.has(col)) continue
    const oldVal = oldData[col]
    const newVal = newData[col]
    if (JSON.stringify(oldVal) === JSON.stringify(newVal)) continue

    changes.push({
      field: FIELD_LABELS[col] ?? col,
      oldValue: formatValue(col, oldVal, fkLabelMap),
      newValue: formatValue(col, newVal, fkLabelMap),
    })
  }

  return changes
}

// ── Value formatting ────────────────────────────────────────

function formatValue(
  col: string,
  val: unknown,
  fkLabelMap: Record<string, string>,
): string | null {
  if (val === null || val === undefined) return null

  // Resolve FK UUIDs to labels
  if (col in FK_RESOLVE_MAP && typeof val === 'string' && isUuid(val)) {
    return fkLabelMap[val] ?? 'Unknown'
  }

  // Special formatting
  if (col === 'unit_price_cents' && typeof val === 'number') {
    return `$${(val / 100).toFixed(2)}`
  }
  if (col === 'contractor_fault' || col === 'is_extra' || col === 'is_mud' || col === 'is_internal') {
    return val ? 'Yes' : 'No'
  }
  if (col === 'is_open') {
    return val ? 'Open' : 'Closed'
  }
  if (col === 'date' || col === 'rescheduled_date') {
    return formatDate(String(val))
  }
  if (col.endsWith('_at') && typeof val === 'string') {
    return formatTimestamp(val)
  }

  if (typeof val === 'object') {
    return JSON.stringify(val)
  }

  return String(val)
}

function formatDate(val: string): string {
  try {
    return format(new Date(val), 'd MMM yyyy')
  } catch {
    return val
  }
}

function formatTimestamp(val: string): string {
  try {
    return format(new Date(val), 'd MMM yyyy, h:mmaaa')
  } catch {
    return val
  }
}

// ── Summary generation ──────────────────────────────────────

export const TABLE_LABELS: Record<string, string> = {
  booking: 'Booking',
  booking_item: 'Service item',
  non_conformance_notice: 'NCN',
  nothing_presented: 'Nothing Presented',
  service_ticket: 'Ticket',
  ticket_response: 'Response',
  collection_date: 'Collection date',
  strata_user_properties: 'MUD property link',
  contacts: 'Contact',
  eligible_properties: 'Property',
}

function generateSummary(
  action: string,
  tableName: string,
  changes: AuditChange[],
): string {
  const tableLabel = TABLE_LABELS[tableName] ?? tableName

  if (action === 'INSERT') return `${tableLabel} created`
  if (action === 'DELETE') return `${tableLabel} deleted`

  // UPDATE — look for key field changes to generate a meaningful summary
  const statusChange = changes.find((c) => c.field === 'Status')
  if (statusChange && statusChange.newValue) {
    return `Status changed to ${statusChange.newValue}`
  }

  const isOpenChange = changes.find((c) => c.field === 'Open for Bookings')
  if (isOpenChange) {
    return isOpenChange.newValue === 'Open' ? 'Bookings opened' : 'Bookings closed'
  }

  if (changes.length === 1) {
    return `${changes[0].field} updated`
  }

  return `${changes.length} fields updated`
}

// ── Helpers ─────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(val: string): boolean {
  return UUID_RE.test(val)
}
