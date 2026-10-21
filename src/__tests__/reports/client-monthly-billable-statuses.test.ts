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
 *
 * get_booking_tally (VER-323) is the council-facing count on the admin bookings
 * screen. WMRC checks D&M's invoices against it, so it must count exactly as
 * the invoice does: if the two ever disagree the tally has made reconciliation
 * worse, not better. It is held to the same status set AND to the invoice's
 * counting rules (unit expression, mattress handling, date anchors, soft
 * deletes, the our-fault Nothing Presented / Non-conformance exclusion of ADR 0039) — change one
 * function and this fails until the other matches.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../supabase/migrations')
const REPORT_FN = 'get_client_monthly_report'
const TALLY_FN = 'get_booking_tally'

const BILLABLE = ['Completed', 'Non-conformance', 'Nothing Presented'] as const
const NOT_BILLABLE = ['Scheduled', 'Cancelled', 'Rebooked', 'Missed Collection'] as const

/**
 * Counting rules both functions must contain verbatim (whitespace and case
 * normalised). Each is in the invoice RPC today; the tally copies it.
 */
const SHARED_RULES = [
  // Units billed per booking item: the crew's actual count, else the booked count.
  'coalesce(bi.actual_services, bi.no_services)',
  // ADR 0039: a Nothing Presented or Non-conformance the office recorded as
  // D&M's fault is not billed — per waste stream for booked items (a stop-less
  // legacy record takes the whole booking), per stop for crew-logged mattresses.
  'from nothing_presented np left join collection_stop npcs on npcs.id = np.collection_stop_id where np.booking_id = b.id and np.contractor_fault and (np.collection_stop_id is null or npcs.stream = s.waste_stream)',
  'from non_conformance_notice ncn left join collection_stop ncncs on ncncs.id = ncn.collection_stop_id where ncn.booking_id = b.id and ncn.contractor_fault and (ncn.collection_stop_id is null or ncncs.stream = s.waste_stream)',
  'from nothing_presented np where np.collection_stop_id = cs.id and np.contractor_fault',
  'from non_conformance_notice ncn where ncn.collection_stop_id = cs.id and ncn.contractor_fault',
  // ...from the same effective date (01/10/2026), so invoiced months stay as billed.
  "date '2026-10-01'",
  // Crew-logged mattresses (VV-style tenants) are summed from the stop...
  'sum(cs.mattress_count)',
  'cs.mattress_count is not null',
  // ...and the booked mattress items are dropped so they are not billed twice.
  'not (s.is_mattress and v_has_mattress_stream)',
  // Month = the ITEM's collection date for booked units, the STOP's for mattresses.
  'cd.id = bi.collection_date_id',
  'cd.id = cs.collection_date_id',
  // Soft-deleted bookings never count.
  'b.deleted_at is null',
] as const

/** The newest migration containing a CREATE OR REPLACE of the RPC wins — that
 *  is the definition prod ends up with after `db push`. */
function currentDefinition(fn: string): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) =>
      readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8').includes(
        `CREATE OR REPLACE FUNCTION public.${fn}`,
      ),
    )

  const latest = files.at(-1)
  if (!latest) throw new Error(`No migration defines public.${fn}`)

  const sql = readFileSync(path.join(MIGRATIONS_DIR, latest), 'utf8')
  const body = /\$function\$([\s\S]*?)\$function\$/.exec(sql)
  if (!body?.[1]) throw new Error(`Could not read the ${fn} body from ${latest}`)
  return body[1]
}

/** Status literals inside one branch's WHERE, e.g. `'Completed'::booking_status`. */
function statusesFor(body: string, cast: 'booking_status' | 'stop_status'): string[] {
  const found = [...body.matchAll(new RegExp(`'([^']+)'::${cast}`, 'g'))].map((m) => m[1]!)
  return [...new Set(found)].sort()
}

/** SQL with comments stripped, whitespace collapsed and case folded, so a rule
 *  matches however the statement is wrapped. */
function normalise(body: string): string {
  return body
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .toLowerCase()
}

describe.each([REPORT_FN, TALLY_FN])('%s billable statuses (ADR 0017)', (fn) => {
  const body = currentDefinition(fn)

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

describe('get_booking_tally counts exactly as the invoice does', () => {
  const report = normalise(currentDefinition(REPORT_FN))
  const tally = normalise(currentDefinition(TALLY_FN))

  it.each(SHARED_RULES)('both functions contain: %s', (rule) => {
    expect(report).toContain(rule)
    expect(tally).toContain(rule)
  })
})
