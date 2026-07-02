import { describe, expect, it } from 'vitest'
import { computeNoticeReasons } from '@/lib/reports/notice-types'

describe('computeNoticeReasons (NCN types donut)', () => {
  it('groups, sorts by count desc and buckets past top-4 into Other', () => {
    const rows = [
      ...Array.from({ length: 5 }, () => ({ reason: 'Building Waste' })),
      ...Array.from({ length: 4 }, () => ({ reason: 'Items Obstructed or Not On Verge' })),
      ...Array.from({ length: 3 }, () => ({ reason: 'Oversized Items' })),
      ...Array.from({ length: 2 }, () => ({ reason: 'Hazardous Materials' })),
      { reason: 'Commercial Waste' },
      { reason: 'Loose Green Waste' },
    ]
    expect(computeNoticeReasons(rows)).toEqual([
      { label: 'Building Waste', value: 5 },
      { label: 'Items Obstructed or Not On Verge', value: 4 },
      { label: 'Oversized Items', value: 3 },
      { label: 'Hazardous Materials', value: 2 },
      { label: 'Other', value: 2 },
    ])
  })

  it('returns all reasons untouched when there are 4 or fewer', () => {
    const rows = [{ reason: 'A' }, { reason: 'A' }, { reason: 'B' }]
    expect(computeNoticeReasons(rows)).toEqual([
      { label: 'A', value: 2 },
      { label: 'B', value: 1 },
    ])
  })

  it('labels null/blank reasons Unspecified and breaks ties by label', () => {
    const rows = [{ reason: null }, { reason: '  ' }, { reason: 'A' }, { reason: 'B' }]
    expect(computeNoticeReasons(rows)).toEqual([
      { label: 'Unspecified', value: 2 },
      { label: 'A', value: 1 },
      { label: 'B', value: 1 },
    ])
  })

  it('handles an empty input', () => {
    expect(computeNoticeReasons([])).toEqual([])
  })
})

describe('genuine "Other" reason collision (red team 02/07)', () => {
  it('folds a real Other into the aggregate without double-counting the promoted slice', () => {
    const rows = [
      ...Array.from({ length: 10 }, () => ({ reason: 'Building Waste' })),
      ...Array.from({ length: 8 }, () => ({ reason: 'Other' })), // genuine reason
      ...Array.from({ length: 6 }, () => ({ reason: 'Oversized Items' })),
      ...Array.from({ length: 5 }, () => ({ reason: 'Hazardous Materials' })),
      ...Array.from({ length: 3 }, () => ({ reason: 'Car Parts' })), // promoted
      ...Array.from({ length: 2 }, () => ({ reason: 'Commercial Waste' })),
    ]
    const slices = computeNoticeReasons(rows)
    // No duplicate labels, and the slice total equals the row count exactly.
    expect(new Set(slices.map((s) => s.label)).size).toBe(slices.length)
    expect(slices.reduce((sum, s) => sum + s.value, 0)).toBe(rows.length)
    expect(slices.find((s) => s.label === 'Other')!.value).toBe(8 + 2) // genuine + tail
    expect(slices.find((s) => s.label === 'Car Parts')!.value).toBe(3)
  })
})
