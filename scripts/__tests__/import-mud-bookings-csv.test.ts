import { describe, it, expect } from 'vitest'
import { parseRow, targetStatus } from '../import-mud-bookings-csv'

const BULK = '756932e9-f6da-40e4-bda3-cd63feba0bd0'
const GREEN = '888fd3d5-64db-43f8-b849-f375796d8610'

describe('targetStatus', () => {
  it('maps MUD table statuses; future Booked → Confirmed, past Booked → null', () => {
    expect(targetStatus('Completed', '2026-07-02', '2026-09-01')).toBe('Completed')
    expect(targetStatus('Booked', '2026-09-02', '2026-09-01')).toBe('Confirmed')
    expect(targetStatus('Booked', '2026-09-01', '2026-09-01')).toBe('Confirmed')
    expect(targetStatus('Booked', '2026-08-03', '2026-09-01')).toBeNull()
    expect(targetStatus('Cancelled', '2026-09-02', '2026-09-01')).toBeNull()
  })
  it('past-booked=completed imports past Booked as Completed (Dan confirmed all attended, 01/09/2026)', () => {
    expect(targetStatus('Booked', '2026-08-03', '2026-09-01', 'completed')).toBe('Completed')
    expect(targetStatus('Booked', '2026-09-02', '2026-09-01', 'completed')).toBe('Confirmed')
    expect(targetStatus('Cancelled', '2026-08-03', '2026-09-01', 'completed')).toBeNull()
  })
})

describe('parseRow', () => {
  const base = {
    Booking_Ref: 'MOS-MUD-17-2026', Status: 'Booked',
    'Collection_Date (from Collection_Date)': 'September 2, 2026',
    'MUD Ref (from Address)': 'MOS-MUD-17', No_Bulk: '1', No_Green: '0',
  }
  it('reads ref, mud ref, date and streams', () => {
    const p = parseRow(base)
    expect(p.ref).toBe('MOS-MUD-17-2026')
    expect(p.mudRef).toBe('MOS-MUD-17')
    expect(p.date).toBe('2026-09-02')
    expect(p.services).toEqual([{ service_id: BULK, csvQty: 1 }])
  })
  it('green-only rows book the green stream', () => {
    const p = parseRow({ ...base, No_Bulk: '0', No_Green: '1' })
    expect(p.services).toEqual([{ service_id: GREEN, csvQty: 1 }])
  })
  it('carries a non-standard CSV qty for reporting (units are fixed at 2 on insert)', () => {
    const p = parseRow({ ...base, No_Bulk: '9' })
    expect(p.services).toEqual([{ service_id: BULK, csvQty: 9 }])
  })
  it('blank quantity cells yield no services', () => {
    const p = parseRow({ ...base, No_Bulk: '', No_Green: '' })
    expect(p.services).toEqual([])
  })
})
