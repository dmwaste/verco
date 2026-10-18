import { describe, it, expect } from 'vitest'
import { parseRecord, capacityImpact, refsOutsideFy, F, type AirtableRecord } from '../import-kwn-mud-bookings'

// Every row is stamped with the current FY, so a row collected outside it must
// stop the run for a person to decide: allocations count against the FY of the
// collection, but some councils let a June booking for July use the booked FY
// (Dan, 18/10/2026). The importer can't tell which applies.
describe('refsOutsideFy', () => {
  const fy27 = { start_date: '2026-07-01', end_date: '2027-06-30' }

  it('passes rows collected inside the current FY', () => {
    expect(refsOutsideFy([{ ref: 'A', date: '2026-11-02' }, { ref: 'B', date: '2027-06-30' }], fy27)).toEqual([])
  })

  it('names rows collected after the FY ends or before it starts', () => {
    expect(
      refsOutsideFy(
        [{ ref: 'A', date: '2027-07-05' }, { ref: 'B', date: '2026-11-02' }, { ref: 'C', date: '2026-06-15' }],
        fy27,
      ),
    ).toEqual(['A', 'C'])
  })

  it('ignores undated rows (reported separately)', () => {
    expect(refsOutsideFy([{ ref: 'A', date: null }], fy27)).toEqual([])
  })
})

const BULK = '756932e9-f6da-40e4-bda3-cd63feba0bd0'
const GREEN = '888fd3d5-64db-43f8-b849-f375796d8610'

// Shape of a KWN "MUD Bookings" row as the REST API returns it with
// returnFieldsByFieldId=true (lookups come back as arrays, the single-select
// as a plain string, the link as record ids).
const row: AirtableRecord = {
  id: 'recBooking1',
  createdTime: '2026-06-30T05:23:12.000Z',
  fields: {
    [F.ref]: 'KWN-MDD-15-1312',
    [F.status]: 'Booked',
    [F.addressLink]: ['reckXfNU6gzkcuFLJ'],
    [F.address]: ['15 Worrall Court Orelia'],
    [F.date]: ['2026-11-02'],
    [F.mudRef]: ['KWN-MDD-15'],
    [F.bulk]: 1,
    [F.green]: 1,
  },
}

describe('parseRecord', () => {
  it('reads ref, status, the Address link (property bridge), date and both streams', () => {
    const p = parseRecord(row)
    expect(p.ref).toBe('KWN-MDD-15-1312')
    expect(p.status).toBe('Booked')
    expect(p.addressRecId).toBe('reckXfNU6gzkcuFLJ')
    expect(p.mudRef).toBe('KWN-MDD-15')
    expect(p.address).toBe('15 Worrall Court Orelia')
    expect(p.date).toBe('2026-11-02')
    expect(p.services).toEqual([{ service_id: BULK, csvQty: 1 }, { service_id: GREEN, csvQty: 1 }])
  })
  it('bulk-only rows book only the bulk stream', () => {
    const p = parseRecord({ ...row, fields: { ...row.fields, [F.green]: 0 } })
    expect(p.services).toEqual([{ service_id: BULK, csvQty: 1 }])
  })
  it('a row with no Status (151 legacy rows) parses with a blank status so it lands in the unknown_status bucket', () => {
    const p = parseRecord({ ...row, fields: { ...row.fields, [F.status]: undefined } })
    expect(p.status).toBe('')
  })
  it('missing Address link or date yields null, never a throw', () => {
    const p = parseRecord({ ...row, fields: { [F.ref]: 'X' } })
    expect(p.addressRecId).toBeNull()
    expect(p.date).toBeNull()
    expect(p.services).toEqual([])
  })
  it('rejects a date that is not YYYY-MM-DD (wrong lookup field)', () => {
    const p = parseRecord({ ...row, fields: { ...row.fields, [F.date]: ['Monday 2nd November'] } })
    expect(p.date).toBeNull()
  })
})

describe('capacityImpact', () => {
  const dates = new Map([
    ['cd1', { code: 'KWN-1', date: '2026-11-02', limit: 70, booked: 41 }],
    ['cd3', { code: 'KWN-3', date: '2026-11-04', limit: 70, booked: 70 }],
  ])
  it('sums units per date and flags dates pushed past their bulk limit', () => {
    const r = capacityImpact([
      { cdId: 'cd1', units: 4 }, { cdId: 'cd1', units: 4 },
      { cdId: 'cd3', units: 4 },
    ], dates)
    expect(r.rows).toEqual([
      { cdId: 'cd1', code: 'KWN-1', date: '2026-11-02', limit: 70, booked: 41, adding: 8, after: 49 },
      { cdId: 'cd3', code: 'KWN-3', date: '2026-11-04', limit: 70, booked: 70, adding: 4, after: 74 },
    ])
    expect(r.over).toEqual(['KWN-3 2026-11-04'])
  })
  it('an empty plan has no rows and nothing over', () => {
    expect(capacityImpact([], dates)).toEqual({ rows: [], over: [] })
  })
})
