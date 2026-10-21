import { describe, expect, it } from 'vitest'
import { buildTally, parseTally } from '@/app/(admin)/admin/bookings/tally-model'

/**
 * The bookings-screen totals (VER-323). Councils check D&M's invoices against
 * these numbers, so the pivot must keep the RPC's billable flag (the SQL is the
 * only place the billable set lives), put crew-logged mattresses in the
 * Mattress column, and split Included (council) from Extras (resident-paid).
 */

const booked = (
  status: string,
  billable: boolean,
  category: string,
  service: string,
  units: number,
  is_extra = false,
  contractor_fault = false,
) => ({ source: 'booked' as const, status, billable, contractor_fault, category, service, is_extra, units })

const RAW = {
  bookings: [
    { status: 'Cancelled', billable: false, contractor_fault: false, bookings: 5 },
    { status: 'Nothing Presented', billable: true, contractor_fault: false, bookings: 2 },
    { status: 'Completed', billable: true, contractor_fault: false, bookings: 10 },
    { status: 'Scheduled', billable: false, contractor_fault: false, bookings: 1 },
    { status: 'Non-conformance', billable: true, contractor_fault: false, bookings: 3 },
  ],
  units: [
    booked('Completed', true, 'bulk', 'Green Waste', 4),
    booked('Completed', true, 'bulk', 'Bulk Waste', 9),
    booked('Completed', true, 'bulk', 'Bulk Waste', 2, true),
    booked('Completed', true, 'id', 'Illegal Dumping', 1),
    booked('Non-conformance', true, 'bulk', 'Bulk Waste', 3),
    booked('Nothing Presented', true, 'bulk', 'Green Waste', 2),
    booked('Cancelled', false, 'bulk', 'Bulk Waste', 5),
    booked('Scheduled', false, 'anc', 'E-Waste', 1),
    { source: 'stop_mattress' as const, status: 'Completed', billable: true, contractor_fault: false, units: 6 },
  ],
}

describe('parseTally', () => {
  it('accepts the RPC payload', () => {
    expect(parseTally(RAW).ok).toBe(true)
  })

  it('rejects a payload missing the billable flag, rather than guessing it', () => {
    const bad = { bookings: [{ status: 'Completed', contractor_fault: false, bookings: 1 }], units: [] }
    expect(parseTally(bad).ok).toBe(false)
  })

  it('rejects a payload missing the contractor-fault flag', () => {
    const bad = { bookings: [{ status: 'Completed', billable: true, bookings: 1 }], units: [] }
    expect(parseTally(bad).ok).toBe(false)
  })
})

describe('buildTally', () => {
  const parsed = parseTally(RAW)
  if (!parsed.ok) throw new Error(parsed.error)
  const t = buildTally(parsed.data)

  it('orders columns bulk → ancillary → illegal dumping, with crew mattresses in Mattress', () => {
    expect(t.columns).toEqual(['Bulk Waste', 'Green Waste', 'E-Waste', 'Mattress', 'Illegal Dumping'])
  })

  it('lists the attended outcomes in order, Nothing Presented as its own line', () => {
    expect(t.billable.map((r) => r.status)).toEqual(['Completed', 'Non-conformance', 'Nothing Presented'])
    const completed = t.billable[0]!
    expect(completed.bookings).toBe(10)
    expect(completed.included).toEqual({ 'Bulk Waste': 9, 'Green Waste': 4, Mattress: 6, 'Illegal Dumping': 1 })
    expect(completed.includedTotal).toBe(20)
    expect(completed.extrasTotal).toBe(2)
  })

  it('subtotals the billable rows from the RPC flag', () => {
    expect(t.billableTotal.bookings).toBe(15)
    expect(t.billableTotal.included).toEqual({
      'Bulk Waste': 12,
      'Green Waste': 6,
      Mattress: 6,
      'Illegal Dumping': 1,
    })
    expect(t.billableTotal.includedTotal).toBe(25)
    expect(t.billableTotal.extras).toEqual({ 'Bulk Waste': 2 })
  })

  it('lists the rest outside the billable total, each with its reason', () => {
    expect(t.other.map((r) => [r.status, r.reason])).toEqual([
      ['Scheduled', 'outcome not recorded'],
      ['Cancelled', 'not attended'],
    ])
    expect(t.other.every((r) => !/non-?chargeable/i.test(r.reason))).toBe(true)
  })

  it('totals every filtered booking and unit', () => {
    expect(t.total.bookings).toBe(21)
    expect(t.total.includedTotal).toBe(31)
    expect(t.total.extrasTotal).toBe(2)
    expect(t.hasExtras).toBe(true)
    expect(t.hasCrewMattresses).toBe(true)
  })

  it('trusts the flag over the status name', () => {
    // If the SQL ever moved a status in or out of the billable set, the screen
    // follows the SQL — it has no copy of its own to drift.
    const p = parseTally({
      bookings: [{ status: 'Scheduled', billable: true, contractor_fault: false, bookings: 1 }],
      units: [booked('Scheduled', true, 'bulk', 'Bulk Waste', 1)],
    })
    if (!p.ok) throw new Error(p.error)
    const flipped = buildTally(p.data)
    expect(flipped.billable.map((r) => r.status)).toEqual(['Scheduled'])
    expect(flipped.other).toEqual([])
  })

  it('keeps a status that has units but no booking count (a mattress stop on a moved date)', () => {
    const p = parseTally({
      bookings: [],
      units: [{ source: 'stop_mattress', status: 'Completed', billable: true, contractor_fault: false, units: 2 }],
    })
    if (!p.ok) throw new Error(p.error)
    const only = buildTally(p.data)
    expect(only.billable).toHaveLength(1)
    expect(only.billable[0]).toMatchObject({ status: 'Completed', bookings: 0, includedTotal: 2 })
  })

  it("lists an our-fault Nothing Presented on its own line outside the billable total (ADR 0039)", () => {
    const p = parseTally({
      bookings: [
        { status: 'Nothing Presented', billable: true, contractor_fault: false, bookings: 4 },
        { status: 'Nothing Presented', billable: false, contractor_fault: true, bookings: 1 },
      ],
      units: [
        booked('Nothing Presented', true, 'bulk', 'Bulk Waste', 4),
        booked('Nothing Presented', false, 'bulk', 'Green Waste', 2, false, true),
      ],
    })
    if (!p.ok) throw new Error(p.error)
    const t = buildTally(p.data)

    // The billable NP line keeps only the resident-caused ones...
    expect(t.billable).toHaveLength(1)
    expect(t.billable[0]).toMatchObject({ label: 'Nothing Presented', bookings: 4, includedTotal: 4 })
    // ...and ours sits outside the total, named for what it is.
    expect(t.other).toHaveLength(1)
    expect(t.other[0]).toMatchObject({
      label: "Nothing Presented — D&M's fault",
      reason: "not billed: D&M's fault",
      bookings: 1,
      includedTotal: 2,
    })
    expect(t.billableTotal.includedTotal).toBe(4)
    expect(t.total.includedTotal).toBe(6)
  })

  it('is empty for an empty result', () => {
    const p = parseTally({ bookings: [], units: [] })
    if (!p.ok) throw new Error(p.error)
    const empty = buildTally(p.data)
    expect(empty.total.bookings).toBe(0)
    expect(empty.columns).toEqual([])
    expect(empty.hasExtras).toBe(false)
  })
})
