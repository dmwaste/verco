import { describe, expect, it } from 'vitest'
import { closureStatus } from '@/lib/collection-dates/closure-status'

const holidays = new Map<string, string>([
  ['2026-06-01', 'WA Day'],
  ['2026-12-25', 'Christmas Day'],
])

describe('closureStatus', () => {
  it("returns 'open' for an open date regardless of holiday match", () => {
    expect(closureStatus(true, '2026-06-01', holidays)).toBe('open')
    expect(closureStatus(true, '2026-05-20', holidays)).toBe('open')
  })

  it("returns 'holiday' when a closed date falls on a known public holiday", () => {
    expect(closureStatus(false, '2026-06-01', holidays)).toBe('holiday')
    expect(closureStatus(false, '2026-12-25', holidays)).toBe('holiday')
  })

  it("returns 'closed' when a closed date is not a public holiday", () => {
    expect(closureStatus(false, '2026-05-20', holidays)).toBe('closed')
  })

  it("returns 'closed' for a closed date when the holiday map is empty", () => {
    expect(closureStatus(false, '2026-06-01', new Map())).toBe('closed')
  })
})
