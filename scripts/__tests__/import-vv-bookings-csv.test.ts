import { describe, it, expect } from 'vitest'
import { looseKey, normAddr, parseDate, parseRow, targetStatus } from '../import-vv-bookings-csv'
import { parseCsv } from '../lib/csv'

describe('parseDate', () => {
  it('reads the Airtable lookup format', () => {
    expect(parseDate('July 7, 2026')).toBe('2026-07-07')
    expect(parseDate('September 24, 2026')).toBe('2026-09-24')
    expect(parseDate('')).toBeNull()
    expect(parseDate('260106 | Tuesday 6th January | VIN-B')).toBeNull()
  })
})

describe('address keys', () => {
  it('exact key collapses case and whitespace', () => {
    expect(normAddr('54 The Boulevarde  MOUNT HAWTHORN')).toBe('54 THE BOULEVARDE MOUNT HAWTHORN')
  })
  it('loose key bridges raw ↔ geocoded ↔ stray-space forms', () => {
    const k = looseKey('12/49 Elizabeth ST NORTH PERTH')
    expect(looseKey('12/49 Elizabeth St, North Perth WA 6006, Australia')).toBe(k)
    expect(looseKey('2 /64 Brady ST MOUNT HAWTHORN')).toBe(looseKey('2/64 Brady ST MOUNT HAWTHORN'))
    expect(looseKey('31 GILL STREET North Perth')).toBe(looseKey('31 Gill St, North Perth WA 6006, Australia'))
    expect(looseKey('Nowhere')).toBeNull()
  })
})

describe('targetStatus', () => {
  it('maps master statuses; future Booked → Confirmed, past Booked → null', () => {
    expect(targetStatus('Completed', '2026-07-02', '2026-08-23')).toBe('Completed')
    expect(targetStatus('Non-Conformance', '2026-07-02', '2026-08-23')).toBe('Non-conformance')
    expect(targetStatus('Booked', '2026-09-01', '2026-08-23')).toBe('Confirmed')
    expect(targetStatus('Place Out Issued', '2026-08-23', '2026-08-23')).toBe('Confirmed')
    expect(targetStatus('Booked', '2026-08-20', '2026-08-23')).toBeNull()
    expect(targetStatus('Cancelled', '2026-09-01', '2026-08-23')).toBeNull()
  })
})

describe('parseRow', () => {
  const base = { Booking_Ref: 'VIN-B-1', 'Eligible Properties': '1 Bondi ST MOUNT HAWTHORN', Status: 'Completed', 'Collection_Date (from Collection_Date)': 'July 7, 2026', Waste_Location: 'Driveway (Verge side of letterbox)', Contact_Email: 'A@B.COM', Contact_Name: 'Ann Smith', Contact_Phone: '+61400000000', No_Bulk: '2', No_Green: '0', VVE_Bulk: '0', VVE_Green: '0', VVE_Mattress: '1' }
  it('splits paid VVE units into is_extra items at price 0 and normalises location', () => {
    const p = parseRow(base)
    expect(p.services).toEqual([
      { service_id: '756932e9-f6da-40e4-bda3-cd63feba0bd0', qty: 2, is_extra: false },
      { service_id: '9a0538d8-111c-452a-9483-3d20b07725a4', qty: 1, is_extra: true },
    ])
    expect(p.location).toBe('Driveway')
    expect(p.contactEmail).toBe('a@b.com')
    expect(p.date).toBe('2026-07-07')
  })
  it('paid portion of a total is carved out, not added', () => {
    const p = parseRow({ ...base, No_Green: '1', VVE_Green: '1', VVE_Mattress: '0' })
    expect(p.services.find((s) => s.service_id === '888fd3d5-64db-43f8-b849-f375796d8610')).toEqual({ service_id: '888fd3d5-64db-43f8-b849-f375796d8610', qty: 1, is_extra: true })
  })
})

describe('parseCsv', () => {
  it('handles quoted fields with commas, quotes and newlines, and a BOM', () => {
    const rows = parseCsv('﻿a,b\n1,"x, ""y""\nz"\n2,\n')
    expect(rows).toEqual([{ a: '1', b: 'x, "y"\nz' }, { a: '2', b: '' }])
  })
})
