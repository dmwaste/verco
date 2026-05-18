import { describe, it, expect } from 'vitest'
import {
  effectiveCapacity,
  indexPoolDates,
  type CollectionDateCapacity,
  type CollectionDatePoolCapacity,
} from '@/lib/capacity/effective-capacity'

const dateRow = (overrides: Partial<CollectionDateCapacity> = {}): CollectionDateCapacity => ({
  date: '2026-05-20',
  bulk_capacity_limit: 60,
  bulk_units_booked: 5,
  bulk_is_closed: false,
  anc_capacity_limit: 20,
  anc_units_booked: 2,
  anc_is_closed: false,
  id_capacity_limit: 10,
  id_units_booked: 0,
  id_is_closed: false,
  ...overrides,
})

const poolRow = (overrides: Partial<CollectionDatePoolCapacity> = {}): CollectionDatePoolCapacity => ({
  date: '2026-05-20',
  bulk_capacity_limit: 60,
  bulk_units_booked: 12,
  bulk_is_closed: false,
  anc_capacity_limit: 20,
  anc_units_booked: 3,
  anc_is_closed: false,
  id_capacity_limit: 10,
  id_units_booked: 1,
  id_is_closed: false,
  ...overrides,
})

describe('indexPoolDates', () => {
  it('returns an empty Map for an empty array', () => {
    const idx = indexPoolDates([])
    expect(idx.size).toBe(0)
  })

  it('keys by date string for O(1) lookup', () => {
    const a = poolRow({ date: '2026-05-20' })
    const b = poolRow({ date: '2026-05-27' })
    const idx = indexPoolDates([a, b])
    expect(idx.size).toBe(2)
    expect(idx.get('2026-05-20')).toEqual(a)
    expect(idx.get('2026-05-27')).toEqual(b)
    expect(idx.get('2026-06-03')).toBeUndefined()
  })
})

describe('effectiveCapacity — unpooled area', () => {
  it('returns the date row counters verbatim when poolId is null', () => {
    const row = dateRow()
    const out = effectiveCapacity(row, null, new Map())
    expect(out).toEqual({
      bulk_capacity_limit: 60,
      bulk_units_booked: 5,
      bulk_is_closed: false,
      anc_capacity_limit: 20,
      anc_units_booked: 2,
      anc_is_closed: false,
      id_capacity_limit: 10,
      id_units_booked: 0,
      id_is_closed: false,
    })
  })

  it('ignores poolByDate entries when poolId is null', () => {
    const row = dateRow()
    const idx = indexPoolDates([poolRow({ bulk_capacity_limit: 999 })])
    const out = effectiveCapacity(row, null, idx)
    expect(out.bulk_capacity_limit).toBe(60)
  })
})

describe('effectiveCapacity — pooled area', () => {
  it('returns the matching pool row counters when poolId set and pool row exists', () => {
    const row = dateRow({ bulk_capacity_limit: 0, bulk_units_booked: 0 })
    const idx = indexPoolDates([poolRow({ bulk_capacity_limit: 60, bulk_units_booked: 12 })])
    const out = effectiveCapacity(row, 'pool-1', idx)
    expect(out.bulk_capacity_limit).toBe(60)
    expect(out.bulk_units_booked).toBe(12)
  })

  it('treats a date with no matching pool row as fully closed (booking RPC would reject)', () => {
    const row = dateRow()
    const out = effectiveCapacity(row, 'pool-1', new Map())
    expect(out).toEqual({
      bulk_capacity_limit: 0,
      bulk_units_booked: 0,
      bulk_is_closed: true,
      anc_capacity_limit: 0,
      anc_units_booked: 0,
      anc_is_closed: true,
      id_capacity_limit: 0,
      id_units_booked: 0,
      id_is_closed: true,
    })
  })

  it('ignores the per-area counters entirely (they stay 0 by design for pool members)', () => {
    const row = dateRow({
      bulk_capacity_limit: 999,
      bulk_units_booked: 888,
      bulk_is_closed: false,
    })
    const idx = indexPoolDates([poolRow({ bulk_capacity_limit: 60, bulk_units_booked: 5 })])
    const out = effectiveCapacity(row, 'pool-1', idx)
    expect(out.bulk_capacity_limit).toBe(60)
    expect(out.bulk_units_booked).toBe(5)
  })

  it('propagates pool closed flags independently per category', () => {
    const idx = indexPoolDates([
      poolRow({ bulk_is_closed: true, anc_is_closed: false, id_is_closed: true }),
    ])
    const out = effectiveCapacity(dateRow(), 'pool-1', idx)
    expect(out.bulk_is_closed).toBe(true)
    expect(out.anc_is_closed).toBe(false)
    expect(out.id_is_closed).toBe(true)
  })
})
