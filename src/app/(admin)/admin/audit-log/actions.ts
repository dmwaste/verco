'use server'

import { createClient } from '@/lib/supabase/server'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import {
  collectFkUuids,
  diffData,
  resolveActorNames,
  resolveFkLabels,
  TABLE_LABELS,
  type AuditChange,
  type ResolvedAuditEntry,
} from '@/lib/audit/resolve'

interface FetchAuditLogsParams {
  tableName?: string
  action?: string
  limit?: number
  offset?: number
}

export async function fetchAuditLogs(
  params: FetchAuditLogsParams,
): Promise<
  | { ok: true; data: ResolvedAuditEntry[]; total: number }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { tableName, action, limit = 50, offset = 0 } = params

  // Scope to the tenant selected in the admin switcher. audit_log is RLS-gated
  // by accessible_client_ids(), so a contractor-admin (who can see every client)
  // would otherwise get a merged cross-tenant audit trail.
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  let query = supabase
    .from('audit_log')
    .select('id, table_name, record_id, action, old_data, new_data, changed_by, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (clientId) query = query.eq('client_id', clientId)
  if (tableName) query = query.eq('table_name', tableName)
  if (action) query = query.eq('action', action)

  const { data: entries, error, count } = await query

  if (error) return { ok: false, error: error.message }
  if (!entries) return { ok: true, data: [], total: 0 }

  // Resolve actor names + FK labels in batch (same helpers the detail
  // timeline uses — avoids duplicated diff/format logic drifting per
  // surface).
  const actorIds = [
    ...new Set(entries.map((e) => e.changed_by).filter(Boolean)),
  ] as string[]
  const actorMap = await resolveActorNames(supabase, actorIds)

  const fkUuids = collectFkUuids(entries)
  const fkLabelMap = await resolveFkLabels(supabase, fkUuids)

  const resolved: ResolvedAuditEntry[] = entries.map((entry) => {
    const changes = diffData(
      entry.old_data as Record<string, unknown> | null,
      entry.new_data as Record<string, unknown> | null,
      fkLabelMap,
    )
    const tableLabel = TABLE_LABELS[entry.table_name] ?? entry.table_name

    // Global view prefixes table label so cross-table summaries are
    // disambiguable. Single-record timeline (resolve.ts) omits the prefix
    // because the table is already established by the page.
    const summary = buildGlobalSummary(entry.action, tableLabel, changes)

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

  return { ok: true, data: resolved, total: count ?? entries.length }
}

function buildGlobalSummary(
  action: string,
  tableLabel: string,
  changes: AuditChange[],
): string {
  if (action === 'INSERT') return `${tableLabel} created`
  if (action === 'DELETE') return `${tableLabel} deleted`

  const statusChange = changes.find((c) => c.field === 'Status')
  if (statusChange?.newValue) {
    return `${tableLabel} status → ${statusChange.newValue}`
  }
  if (changes.length === 1) {
    return `${tableLabel}: ${changes[0].field} updated`
  }
  return `${tableLabel}: ${changes.length} fields updated`
}
