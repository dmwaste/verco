import { describe, it, expect } from 'vitest'
import { formatFinancialYearLabel } from '@/lib/booking/financial-year'

describe('formatFinancialYearLabel', () => {
  it('expands FY26 to the friendly form', () => {
    expect(formatFinancialYearLabel('FY26')).toBe('Financial Year 2025/26')
  })

  it('expands other two-digit FY codes', () => {
    expect(formatFinancialYearLabel('FY27')).toBe('Financial Year 2026/27')
    expect(formatFinancialYearLabel('FY30')).toBe('Financial Year 2029/30')
  })

  it('trims surrounding whitespace', () => {
    expect(formatFinancialYearLabel(' FY26 ')).toBe('Financial Year 2025/26')
  })

  it('passes through labels that are not the FYnn shape', () => {
    expect(formatFinancialYearLabel('2025/26')).toBe('2025/26')
    expect(formatFinancialYearLabel('FY2026')).toBe('FY2026')
    expect(formatFinancialYearLabel('')).toBe('')
  })
})
