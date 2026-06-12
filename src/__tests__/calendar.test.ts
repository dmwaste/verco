import { describe, it, expect } from 'vitest'
import { isSameMonth } from 'date-fns'
import { uniqueMonths, monthGrid } from '@/lib/booking/calendar'

describe('uniqueMonths', () => {
  it('collapses dates to distinct ascending months', () => {
    const months = uniqueMonths([
      new Date(2026, 5, 15),
      new Date(2026, 5, 22),
      new Date(2026, 6, 6),
      new Date(2026, 7, 3),
    ])
    expect(months.map((m) => `${m.getFullYear()}-${m.getMonth()}`)).toEqual([
      '2026-5',
      '2026-6',
      '2026-7',
    ])
  })

  it('returns an empty list for no dates', () => {
    expect(uniqueMonths([])).toEqual([])
  })

  it('sorts out-of-order input ascending', () => {
    const months = uniqueMonths([new Date(2026, 7, 3), new Date(2026, 5, 1)])
    expect(months.map((m) => m.getMonth())).toEqual([5, 7])
  })
})

describe('monthGrid', () => {
  it('returns whole weeks starting Monday and ending Sunday', () => {
    const grid = monthGrid(new Date(2026, 5, 15)) // June 2026
    expect(grid.length % 7).toBe(0)
    expect(grid[0]!.getDay()).toBe(1) // Monday
    expect(grid[grid.length - 1]!.getDay()).toBe(0) // Sunday
  })

  it('covers every day of the target month', () => {
    const grid = monthGrid(new Date(2026, 5, 1))
    const inJune = grid.filter((d) => isSameMonth(d, new Date(2026, 5, 1)))
    expect(inJune.length).toBe(30) // June has 30 days
  })
})
