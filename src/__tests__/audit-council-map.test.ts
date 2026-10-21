import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every audited table has a council rule (#614, ADR 0036).
 *
 * Council-scoped staff see an audit entry only when it carries their council
 * (audit_log.sub_client_id), which audit_log_sub_client_id() works out per
 * table. A table that gains an audit trigger but isn't mapped there leaves its
 * history blank for council staff without anyone noticing. Map it, or add it to
 * UNTAGGED with the reason the migration header gives.
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
