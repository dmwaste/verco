import { describe, it, expect } from 'vitest'
import {
  computeCollectionsTrend,
  type CollectionsTrendRow,
} from '@/lib/reports/collections-trend'

/**
 * Collections trend — collections per month (VER-294).
 *
 * Mirrors the `get_collections_trend` RPC so the bucketing arithmetic is
 * DB-independent + unit-testable. Pure: each row is one booking_item
 * (bookingId + collection date); a booking counts ONCE, in the month of its
 * MIN item date. Months between the first and last observed month are
 * gap-filled with 0. The caller pre-filters statuses (reached-the-field set)
 * exactly as clean-collection's caller pre-scopes its sets.
 */
describe('computeCollectionsTrend', () => {
  const row = (bookingId: string, collectionDateIso: string): CollectionsTrendRow => ({
    bookingId,
    collectionDateIso,
  })

  // ── Empty ────────────────────────────────────────────────────────────────
  it('returns [] for an empty input list', () => {
    expect(computeCollectionsTrend([])).toEqual([])
  })

  it('returns [] when every row has a malformed date', () => {
    expect(
      computeCollectionsTrend([row('b1', 'not-a-date'), row('b2', '2026-7-1')]),
    ).toEqual([])
  })

  // ── Core bucketing ───────────────────────────────────────────────────────
  it('counts one single-item booking in its month', () => {
    expect(computeCollectionsTrend([row('b1', '2026-06-15')])).toEqual([
      { month: '2026-06', collections: 1 },
    ])
  })

  it('counts distinct bookings, not items — a multi-item cart counts once', () => {
    const rows = [row('b1', '2026-06-15'), row('b1', '2026-06-15'), row('b2', '2026-06-20')]
    expect(computeCollectionsTrend(rows)).toEqual([{ month: '2026-06', collections: 2 }])
  })

  it('buckets a booking with items on different dates by its MIN date', () => {
    // Cross-month cart: the booking lands in June (its earliest item), never
    // July — and the series range is derived from BUCKETED service dates, so
    // the July item date does not extend the axis either (mirrors the RPC's
    // generate_series over bucketed months).
    const rows = [row('b1', '2026-07-02'), row('b1', '2026-06-28')]
    expect(computeCollectionsTrend(rows)).toEqual([{ month: '2026-06', collections: 1 }])
  })

  it('splits bookings across their respective months', () => {
    const rows = [
      row('b1', '2026-05-04'),
      row('b2', '2026-05-18'),
      row('b3', '2026-06-01'),
    ]
    expect(computeCollectionsTrend(rows)).toEqual([
      { month: '2026-05', collections: 2 },
      { month: '2026-06', collections: 1 },
    ])
  })

  // ── Gap filling ──────────────────────────────────────────────────────────
  it('gap-fills months with zero collections between first and last', () => {
    const rows = [row('b1', '2026-03-10'), row('b2', '2026-06-10')]
    expect(computeCollectionsTrend(rows)).toEqual([
      { month: '2026-03', collections: 1 },
      { month: '2026-04', collections: 0 },
      { month: '2026-05', collections: 0 },
      { month: '2026-06', collections: 1 },
    ])
  })

  it('gap-fills across a year boundary (Dec → Jan rollover)', () => {
    const rows = [row('b1', '2025-11-20'), row('b2', '2026-02-03')]
    expect(computeCollectionsTrend(rows)).toEqual([
      { month: '2025-11', collections: 1 },
      { month: '2025-12', collections: 0 },
      { month: '2026-01', collections: 0 },
      { month: '2026-02', collections: 1 },
    ])
  })

  it('does not extend the series past the last observed month (no wall-clock)', () => {
    const buckets = computeCollectionsTrend([row('b1', '2020-01-15')])
    expect(buckets).toEqual([{ month: '2020-01', collections: 1 }])
  })

  // ── Ordering & robustness ────────────────────────────────────────────────
  it('returns months in ascending order regardless of input order', () => {
    const rows = [row('b3', '2026-06-01'), row('b1', '2026-04-08'), row('b2', '2026-05-30')]
    expect(computeCollectionsTrend(rows).map((b) => b.month)).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
    ])
  })

  it('skips malformed dates but keeps the valid rows', () => {
    const rows = [row('b1', '2026-06-15'), row('b2', 'garbage'), row('b3', '2026-06-16')]
    expect(computeCollectionsTrend(rows)).toEqual([{ month: '2026-06', collections: 2 }])
  })

  it('a booking whose only valid item date wins over its malformed one', () => {
    // Malformed dates never participate in the MIN — 'aaaa' would sort before
    // any digit and silently steal the bucket if it weren't filtered.
    const rows = [row('b1', 'aaaa-bb-cc'), row('b1', '2026-06-15')]
    expect(computeCollectionsTrend(rows)).toEqual([{ month: '2026-06', collections: 1 }])
  })
})
