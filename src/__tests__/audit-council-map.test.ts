import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every audited table has a council rule (#614, ADR 0036) and a client-tier
 * rule (ADR 0037).
 *
 * Council-scoped staff see an audit entry only when it carries their council
 * (audit_log.sub_client_id), which audit_log_sub_client_id() works out per
 * table. A table that gains an audit trigger but isn't mapped there leaves its
 * history blank for council staff without anyone noticing. Map it, or add it to
 * UNTAGGED with the reason the migration header gives.
 *
 * Client-tier staff (client-admin, client-staff) read an audited table's history
 * only if they can read the table itself. A table whose own SELECT policy is
 * contractor-only goes in the D&M-only list that audit_log_select and
 * resolve_actor_names both carry, and here as 'dm-only'.
 */

const MIGRATIONS = join(__dirname, '../../supabase/migrations')

// Deliberately never tagged (see 20261021023000's header for why).
const UNTAGGED = new Set([
  'contacts',
  'client',
  'stop_outcome_correction',
  'bug_report',
  'bug_report_attachment',
  'bug_report_comment',
])

// Can client-tier staff read this table's own rows? Every audited table must be listed.
const CLIENT_TIERS: Record<string, 'visible' | 'dm-only'> = {
  allocation_override: 'visible',
  allocation_rules: 'visible',
  booking: 'visible',
  booking_item: 'visible',
  booking_survey: 'visible',
  bug_report: 'visible',
  bug_report_attachment: 'visible',
  bug_report_comment: 'visible',
  client: 'visible',
  collection_area: 'visible',
  collection_date: 'visible',
  collection_stop: 'visible',
  contacts: 'visible',
  eligible_properties: 'visible',
  non_conformance_notice: 'visible',
  nothing_presented: 'visible',
  property_note: 'visible',
  refund_request: 'visible',
  service_rules: 'visible',
  service_ticket: 'visible',
  stop_outcome_correction: 'dm-only',
  strata_user_properties: 'visible',
  ticket_response: 'visible',
}

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8').replace(/--.*$/gm, ''))

function auditedTables(): Set<string> {
  const tables = new Set<string>()
  for (const sql of files) {
    for (const stmt of sql.split(';')) {
      if (!/EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:public\.)?audit_trigger_fn\s*\(/i.test(stmt)) continue
      const on = /CREATE\s+TRIGGER\s+\w+[\s\S]*?\bON\s+(?:public\.)?(\w+)/i.exec(stmt)
      if (on) tables.add(on[1]!)
    }
  }
  return tables
}

function mappedTables(): Set<string> {
  const latest = files.filter((sql) => sql.includes('FUNCTION public.audit_log_sub_client_id')).at(-1)
  const body = latest?.split('FUNCTION public.audit_log_sub_client_id')[1]?.split('$function$')[1] ?? ''
  const names = [...body.matchAll(/p_table\s*(?:=\s*'(\w+)'|IN\s*\(([^)]*)\))/g)].flatMap((m) =>
    m[1] ? [m[1]] : [...m[2]!.matchAll(/'(\w+)'/g)].map((n) => n[1]!),
  )
  return new Set(names)
}

// The `table_name <> ALL (ARRAY[...])` list in the newest definition of a policy or function.
function dmOnlyList(marker: string): string[] {
  const latest = files.filter((sql) => sql.includes(marker)).at(-1) ?? ''
  const body = latest.slice(latest.lastIndexOf(marker))
  const list = /table_name\s*<>\s*ALL\s*\(\s*ARRAY\[([^\]]*)\]/i.exec(body)?.[1] ?? ''
  return [...list.matchAll(/'(\w+)'/g)].map((m) => m[1]!).sort()
}

describe('audit_log council map (#614)', () => {
  it('finds the audit triggers and the map', () => {
    expect(auditedTables().has('booking')).toBe(true)
    expect(mappedTables().has('booking')).toBe(true)
  })

  it('every audited table is mapped to a council or deliberately left untagged', () => {
    const mapped = mappedTables()
    const missing = [...auditedTables()].filter((t) => !mapped.has(t) && !UNTAGGED.has(t))
    expect(missing).toEqual([])
  })

  it('no table is both mapped and listed as untagged', () => {
    const mapped = mappedTables()
    expect([...UNTAGGED].filter((t) => mapped.has(t))).toEqual([])
  })
})

describe('audit_log client-tier rule (ADR 0037)', () => {
  it('every audited table says whether client-tier staff may read its history', () => {
    expect([...auditedTables()].filter((t) => !(t in CLIENT_TIERS))).toEqual([])
  })

  it('the D&M-only list is the same in the test, audit_log_select and resolve_actor_names', () => {
    const dmOnly = Object.keys(CLIENT_TIERS).filter((t) => CLIENT_TIERS[t] === 'dm-only').sort()
    expect(dmOnly).toContain('stop_outcome_correction')
    expect(dmOnlyList('CREATE POLICY audit_log_select')).toEqual(dmOnly)
    expect(dmOnlyList('FUNCTION public.resolve_actor_names')).toEqual(dmOnly)
  })
})
