import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'

/**
 * Guard on ADR 0017 — the monthly client report bills ATTENDED collections.
 *
 * This is the money line: get_client_monthly_report's status filter decides
 * what goes on a council invoice. It lives in SQL, where the repo has no test
 * harness, and it was already wrong once — a Completed-only filter dropped 420
 * billable units from City of Kwinana's July 2026 statement and invoice.
 *
 * So this test reads the LATEST migration that defines the function and pins
 * the decision itself: three attended statuses in, and specifically NOT the
 * ones whose outcome is unknown (Scheduled), superseded by a redo (Rebooked /
 * Missed Collection), or never attended (Cancelled). A future migration that
 * narrows or widens the set has to change this test deliberately, with the ADR
 * in hand — it cannot happen by accident.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../supabase/migrations')
const FN = 'get_client_monthly_report'

const BILLABLE = ['Completed', 'Non-conformance', 'Nothing Presented'] as const
const NOT_BILLABLE = ['Scheduled', 'Cancelled', 'Rebooked', 'Missed Collection'] as const

/** The newest migration containing a CREATE OR REPLACE of the RPC wins — that
 *  is the definition prod ends up with after `db push`. */
function currentDefinition(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) =>
      readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8').includes(
        `CREATE OR REPLACE FUNCTION public.${FN}`,
      ),
    )

  const latest = files.at(-1)
  if (!latest) throw new Error(`No migration defines public.${FN}`)

  const sql = readFileSync(path.join(MIGRATIONS_DIR, latest), 'utf8')
  const body = /\$function\$([\s\S]*?)\$function\$/.exec(sql)
  if (!body?.[1]) throw new Error(`Could not read the ${FN} body from ${latest}`)
  return body[1]
}

/** Status literals inside one branch's WHERE, e.g. `'Completed'::booking_status`. */
function statusesFor(body: string, cast: 'booking_status' | 'stop_status'): string[] {
  const found = [...body.matchAll(new RegExp(`'([^']+)'::${cast}`, 'g'))].map((m) => m[1]!)
  return [...new Set(found)].sort()
}

describe('get_client_monthly_report billable statuses (ADR 0017)', () => {
  const body = currentDefinition()

  it.each([
    ['booked branch', 'booking_status'],
    ['stop_mattress branch', 'stop_status'],
  ] as const)('%s bills exactly the three attended statuses', (_label, cast) => {
    expect(statusesFor(body, cast)).toEqual([...BILLABLE].sort())
  })

  it.each(NOT_BILLABLE)('never bills %s', (status) => {
    expect(body).not.toContain(`'${status}'`)
  })
})
