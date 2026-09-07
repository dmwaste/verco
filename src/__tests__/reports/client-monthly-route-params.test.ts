import { describe, it, expect } from 'vitest'
import { parseReportParams } from '@/app/(admin)/admin/reports/client-report/pdf/params'
import { lastCompleteMonth } from '@/app/(admin)/admin/reports/client-reports-card'

describe('parseReportParams', () => {
  it('accepts a uuid client and YYYY-MM month', () => {
    const r = parseReportParams('123e4567-e89b-42d3-a456-426614174000', '2026-07')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.monthStart).toBe('2026-07-01')
  })
  it('rejects a malformed month', () => {
    expect(parseReportParams('123e4567-e89b-42d3-a456-426614174000', '2026-13').ok).toBe(false)
    expect(parseReportParams('123e4567-e89b-42d3-a456-426614174000', 'julY').ok).toBe(false)
  })
  it('rejects a non-uuid client', () => {
    expect(parseReportParams('kwn', '2026-07').ok).toBe(false)
  })
  it('rejects nulls', () => {
    expect(parseReportParams(null, null).ok).toBe(false)
  })
})

describe('lastCompleteMonth', () => {
  it('rolls back one month', () => {
    expect(lastCompleteMonth(new Date(2026, 7, 6))).toBe('2026-07')
  })
  it('crosses the year boundary', () => {
    expect(lastCompleteMonth(new Date(2026, 0, 15))).toBe('2025-12')
  })
})
