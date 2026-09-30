import { describe, it, expect, vi, afterEach } from 'vitest'
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
  it('--live-from holds back future Booked rows dated before it (30/09 changeover)', () => {
    expect(targetStatus('Booked', '2026-09-30', '2026-09-30', 'skip', '2026-10-04')).toBeNull()
    expect(targetStatus('Booked', '2026-10-02', '2026-09-30', 'skip', '2026-10-04')).toBeNull()
    expect(targetStatus('Booked', '2026-10-04', '2026-09-30', 'skip', '2026-10-04')).toBe('Confirmed')
    expect(targetStatus('Completed', '2026-09-29', '2026-09-30', 'skip', '2026-10-04')).toBe('Completed')
  })
  it('past-booked=completed never completes a still-future row held back by --live-from', () => {
    expect(targetStatus('Booked', '2026-09-30', '2026-09-30', 'completed', '2026-10-04')).toBeNull()
    expect(targetStatus('Booked', '2026-10-01', '2026-09-30', 'completed', '2026-10-04')).toBeNull()
    expect(targetStatus('Booked', '2026-09-29', '2026-09-30', 'completed', '2026-10-04')).toBe('Completed')
  })
})

describe('today (default)', () => {
  afterEach(() => { vi.useRealTimers(); vi.resetModules() })
  it('is the AWST date — a run at 01:30 AWST 01/10 must not treat 30/09 as today', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T17:30:00Z')) // 01:30 AWST Thu 01/10 — UTC is still 30/09
    vi.resetModules()
    const mod = await import('../import-mud-bookings-csv')
    expect(mod.targetStatus('Booked', '2026-09-30')).toBeNull()
    expect(mod.targetStatus('Booked', '2026-10-01')).toBe('Confirmed')
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
