import { describe, it, expect } from 'vitest'
import {
  computeNotificationReliability,
  NOTIF_LOW_N,
} from '@/lib/reports/notification-reliability'

/**
 * NOTIF — Notification Reliability (spec §3.7), email rows only.
 *
 * delivered% = positive / (positive + negative) × 100, where
 *   positive = delivery_status IN ('delivered','opened')   ('opened' supersedes 'delivered')
 *   negative = delivery_status IN ('bounced','dropped','spam')
 *   excluded = 'deferred' (transient) + null (untracked) — never in the denominator
 *
 * tracked = positive + negative; pct is null when tracked === 0.
 * LOW_N = 10: below it the card shows the raw fraction (no coloured %), at/above it the %.
 */
describe('computeNotificationReliability', () => {
  it('exports LOW_N = 10 per spec §3.7', () => {
    expect(NOTIF_LOW_N).toBe(10)
  })

  it('empty input → all zeros, pct null, isEmpty', () => {
    const r = computeNotificationReliability([])
    expect(r).toEqual({
      positive: 0,
      negative: 0,
      tracked: 0,
      pct: null,
      isEmpty: true,
      isLowN: false,
    })
  })

  it('counts both delivered and opened as positive', () => {
    const r = computeNotificationReliability(['delivered', 'opened', 'delivered'])
    expect(r.positive).toBe(3)
    expect(r.negative).toBe(0)
    expect(r.tracked).toBe(3)
  })

  it('counts bounced, dropped and spam as negative', () => {
    const r = computeNotificationReliability(['bounced', 'dropped', 'spam'])
    expect(r.positive).toBe(0)
    expect(r.negative).toBe(3)
    expect(r.tracked).toBe(3)
  })

  it('excludes deferred (transient) from positive, negative and tracked', () => {
    const r = computeNotificationReliability(['delivered', 'deferred', 'bounced'])
    expect(r.positive).toBe(1)
    expect(r.negative).toBe(1)
    expect(r.tracked).toBe(2) // deferred excluded entirely
  })

  it('excludes null entries from the denominator', () => {
    const r = computeNotificationReliability([
      'delivered',
      null,
      'opened',
      null,
      'bounced',
    ])
    expect(r.positive).toBe(2)
    expect(r.negative).toBe(1)
    expect(r.tracked).toBe(3)
  })

  it('a single bounce across few rows stays low-n (no coloured %), tracked < 10', () => {
    const r = computeNotificationReliability(['delivered', 'delivered', 'bounced'])
    expect(r.tracked).toBe(3)
    expect(r.isLowN).toBe(true)
    expect(r.isEmpty).toBe(false)
    // pct is still computed (raw fraction); the card suppresses the colour, not the math.
    expect(r.pct).toBeCloseTo((2 / 3) * 100, 10)
  })

  it('tracked = 9 (just below LOW_N) is low-n', () => {
    const statuses = [
      ...Array<string>(8).fill('delivered'),
      'bounced',
    ]
    const r = computeNotificationReliability(statuses)
    expect(r.tracked).toBe(9)
    expect(r.isLowN).toBe(true)
    expect(r.isEmpty).toBe(false)
  })

  it('tracked = 10 (exactly LOW_N) is at-n, not low-n', () => {
    const statuses = [
      ...Array<string>(9).fill('delivered'),
      'bounced',
    ]
    const r = computeNotificationReliability(statuses)
    expect(r.tracked).toBe(10)
    expect(r.isLowN).toBe(false)
    expect(r.isEmpty).toBe(false)
    expect(r.pct).toBeCloseTo(90, 10)
  })

  it('computes pct over positive + negative only (deferred/null never dilute it)', () => {
    const r = computeNotificationReliability([
      ...Array<string>(49).fill('delivered'),
      'bounced', // 49 / 50 = 98%
      'deferred',
      'deferred',
      null,
    ])
    expect(r.positive).toBe(49)
    expect(r.negative).toBe(1)
    expect(r.tracked).toBe(50)
    expect(r.pct).toBeCloseTo(98, 10)
    expect(r.isLowN).toBe(false)
    expect(r.isEmpty).toBe(false)
  })

  it('all positive → 100% at-n', () => {
    const r = computeNotificationReliability(Array<string>(12).fill('opened'))
    expect(r.pct).toBe(100)
    expect(r.tracked).toBe(12)
    expect(r.isLowN).toBe(false)
  })

  it('all negative → 0% at-n', () => {
    const r = computeNotificationReliability(Array<string>(10).fill('bounced'))
    expect(r.pct).toBe(0)
    expect(r.tracked).toBe(10)
    expect(r.isLowN).toBe(false)
  })

  it('only excluded statuses (deferred + null) → empty, pct null', () => {
    const r = computeNotificationReliability(['deferred', null, 'deferred'])
    expect(r.tracked).toBe(0)
    expect(r.pct).toBeNull()
    expect(r.isEmpty).toBe(true)
    expect(r.isLowN).toBe(false)
  })

  it('ignores unknown / invalid delivery_status values entirely', () => {
    // A status outside the known lifecycle (e.g. a webhook value we do not score)
    // is neither positive nor negative and must not enter the denominator.
    const r = computeNotificationReliability([
      'delivered',
      'sent', // not a delivery outcome — ignored
      'processed', // ignored
      'bounced',
    ])
    expect(r.positive).toBe(1)
    expect(r.negative).toBe(1)
    expect(r.tracked).toBe(2)
  })

  it('is case-insensitive and trims surrounding whitespace on the status string', () => {
    const r = computeNotificationReliability([' Delivered ', 'OPENED', 'Bounced'])
    expect(r.positive).toBe(2)
    expect(r.negative).toBe(1)
    expect(r.tracked).toBe(3)
  })

  it('tolerates empty-string statuses (treated as untracked, excluded)', () => {
    const r = computeNotificationReliability(['delivered', '', 'opened'])
    expect(r.positive).toBe(2)
    expect(r.negative).toBe(0)
    expect(r.tracked).toBe(2)
  })
})
