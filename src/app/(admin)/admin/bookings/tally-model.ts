import { z } from 'zod'
import type { Result } from '@/lib/result'

/**
 * Pure pivot for the bookings-screen totals (VER-323, ADR 0038). Input is the
 * get_booking_tally payload; output is the table the panel renders.
 *
 * Which statuses are billable comes ONLY from each row's `billable` flag. The
 * SQL is the single place that set lives (pinned to the invoice RPC by
 * client-monthly-billable-statuses.test.ts), so this file has no copy to drift.
 * Crew-logged mattresses (`stop_mattress`) fill the Mattress column; they are
 * always council-included, as on the invoice.
 */

const tallySchema = z.object({
  bookings: z.array(z.object({ status: z.string(), billable: z.boolean(), bookings: z.number() })),
  units: z.array(
    z.discriminatedUnion('source', [
      z.object({
        source: z.literal('booked'),
        status: z.string(),
        billable: z.boolean(),
        category: z.string(),
        service: z.string(),
        is_extra: z.boolean(),
        units: z.number(),
      }),
      z.object({
        source: z.literal('stop_mattress'),
        status: z.string(),
        billable: z.boolean(),
        units: z.number(),
      }),
    ]),
  ),
})

export type TallyPayload = z.infer<typeof tallySchema>

export function parseTally(raw: unknown): Result<TallyPayload> {
  const parsed = tallySchema.safeParse(raw)
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, error: `Unexpected totals response: ${parsed.error.message}` }
}

export interface TallyRow {
  status: string
  bookings: number
  /** Council-included units per service column. */
  included: Record<string, number>
  /** Resident-paid extra units per service column. */
  extras: Record<string, number>
  includedTotal: number
  extrasTotal: number
}

export interface Tally {
  /** Service columns: bulk, then ancillary, then illegal dumping; A→Z within. */
  columns: string[]
  /** Attended outcomes (the invoice's billable set), in outcome order. */
  billable: TallyRow[]
  billableTotal: TallyRow
  /** Everything outside the billable total, with the reason it sits there. */
  other: (TallyRow & { reason: string })[]
  /** Every booking and unit the filters matched. */
  total: TallyRow
  hasExtras: boolean
  /** The tenant logs mattresses at closeout — the panel footnotes the column. */
  hasCrewMattresses: boolean
}

const MATTRESS = 'Mattress'

/** Display order of outcomes. Unknown statuses sort after these. */
const STATUS_ORDER = [
  'Completed',
  'Non-conformance',
  'Nothing Presented',
  'Scheduled',
  'Confirmed',
  'Submitted',
  'Pending Payment',
  'Cancelled',
  'Rebooked',
  'Missed Collection',
]

/** Why a status sits outside the billable total (ADR 0017). Never "non-chargeable". */
const OUTSIDE_REASON: Record<string, string> = {
  Scheduled: 'outcome not recorded',
  Confirmed: 'not collected yet',
  Submitted: 'not collected yet',
  'Pending Payment': 'not collected yet',
  Cancelled: 'not attended',
  Rebooked: 'billed once, on the redo',
  'Missed Collection': 'billed once, on the redo',
}

const CATEGORY_RANK: Record<string, number> = { bulk: 0, anc: 1, id: 2 }

function emptyRow(status: string): TallyRow {
  return { status, bookings: 0, included: {}, extras: {}, includedTotal: 0, extrasTotal: 0 }
}

function addUnits(row: TallyRow, column: string, units: number, extra: boolean) {
  const cells = extra ? row.extras : row.included
  cells[column] = (cells[column] ?? 0) + units
  if (extra) row.extrasTotal += units
  else row.includedTotal += units
}

function sumRows(status: string, rows: TallyRow[]): TallyRow {
  const out = emptyRow(status)
  for (const r of rows) {
    out.bookings += r.bookings
    for (const [c, n] of Object.entries(r.included)) addUnits(out, c, n, false)
    for (const [c, n] of Object.entries(r.extras)) addUnits(out, c, n, true)
  }
  return out
}

const rank = (status: string) => {
  const i = STATUS_ORDER.indexOf(status)
  return i === -1 ? STATUS_ORDER.length : i
}

export function buildTally(payload: TallyPayload): Tally {
  const rows = new Map<string, TallyRow>()
  const billableFlag = new Map<string, boolean>()
  const row = (status: string, billable: boolean) => {
    // A status is billable if the RPC flagged it so on any row.
    billableFlag.set(status, (billableFlag.get(status) ?? false) || billable)
    const existing = rows.get(status)
    if (existing) return existing
    const created = emptyRow(status)
    rows.set(status, created)
    return created
  }

  for (const b of payload.bookings) row(b.status, b.billable).bookings += b.bookings

  const columnRank = new Map<string, number>()
  for (const u of payload.units) {
    if (u.source === 'stop_mattress') {
      addUnits(row(u.status, u.billable), MATTRESS, u.units, false)
      columnRank.set(MATTRESS, CATEGORY_RANK.anc!)
    } else {
      addUnits(row(u.status, u.billable), u.service, u.units, u.is_extra)
      columnRank.set(u.service, Math.min(columnRank.get(u.service) ?? 9, CATEGORY_RANK[u.category] ?? 1))
    }
  }

  const columns = [...columnRank.entries()]
    .sort(([a, ra], [b, rb]) => ra - rb || a.localeCompare(b))
    .map(([name]) => name)

  const ordered = [...rows.values()].sort((a, b) => rank(a.status) - rank(b.status) || a.status.localeCompare(b.status))
  const billable = ordered.filter((r) => billableFlag.get(r.status))
  const other = ordered
    .filter((r) => !billableFlag.get(r.status))
    .map((r) => ({ ...r, reason: OUTSIDE_REASON[r.status] ?? '' }))

  const total = sumRows('All', ordered)
  return {
    columns,
    billable,
    billableTotal: sumRows('Billable (attended)', billable),
    other,
    total,
    hasExtras: total.extrasTotal > 0,
    hasCrewMattresses: payload.units.some((u) => u.source === 'stop_mattress'),
  }
}
