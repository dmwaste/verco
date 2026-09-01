import { describe, it, expect } from 'vitest'
import {
  checkBucketCapacity,
  isMudCollectionDate,
  incrementBucketUnits,
  MUD_UNITS_PER_SERVICE,
  type BucketCapacity,
} from '@/lib/mud/capacity'

const openBucket = (booked: number, limit: number): BucketCapacity => ({
  units_booked: booked,
  capacity_limit: limit,
  is_closed: false,
})

const closedBucket = (booked: number, limit: number): BucketCapacity => ({
  units_booked: booked,
  capacity_limit: limit,
  is_closed: true,
})

describe('checkBucketCapacity', () => {
  it('open bucket with room → ok', () => {
    const r = checkBucketCapacity(openBucket(10, 30), 'bulk', 4)
    expect(r.ok).toBe(true)
    expect(r.remaining).toBe(20)
    expect(r.closed).toBe(false)
  })

  it('open bucket exactly at limit after add → ok (boundary)', () => {
    const r = checkBucketCapacity(openBucket(28, 30), 'bulk', 2)
    expect(r.ok).toBe(true)
    expect(r.remaining).toBe(2)
  })

  it('open bucket overflow → not ok', () => {
    const r = checkBucketCapacity(openBucket(28, 30), 'bulk', 4)
    expect(r.ok).toBe(false)
  })

  it('closed bucket with room → not ok (closed wins)', () => {
    const r = checkBucketCapacity(closedBucket(10, 30), 'anc', 2)
    expect(r.ok).toBe(false)
    expect(r.closed).toBe(true)
  })

  it('zero units request always ok if not closed', () => {
    const r = checkBucketCapacity(openBucket(30, 30), 'id', 0)
    expect(r.ok).toBe(true)
  })

  it('returns the requested bucket name', () => {
    const r = checkBucketCapacity(openBucket(0, 10), 'anc', 1)
    expect(r.bucket).toBe('anc')
  })
})

describe('isMudCollectionDate', () => {
  const pooled = { capacity_pool_id: 'pool-1' }
  const unpooled = { capacity_pool_id: null }

  it('unpooled area: for_mud=true → true', () => {
    expect(isMudCollectionDate({ for_mud: true }, unpooled)).toBe(true)
  })
  it('unpooled area: for_mud=false → false (curated MUD days)', () => {
    expect(isMudCollectionDate({ for_mud: false }, unpooled)).toBe(false)
  })
  it('pooled area: any date qualifies regardless of for_mud (#558 option 2)', () => {
    expect(isMudCollectionDate({ for_mud: false }, pooled)).toBe(true)
    expect(isMudCollectionDate({ for_mud: true }, pooled)).toBe(true)
  })
})

describe('incrementBucketUnits', () => {
  it('adds 2 per service (MUD_UNITS_PER_SERVICE)', () => {
    expect(incrementBucketUnits(10, 3)).toBe(10 + 3 * MUD_UNITS_PER_SERVICE)
  })

  it('zero services → unchanged', () => {
    expect(incrementBucketUnits(10, 0)).toBe(10)
  })

  it('MUD_UNITS_PER_SERVICE constant is 2 (brief Flow 2 step 5)', () => {
    expect(MUD_UNITS_PER_SERVICE).toBe(2)
  })
})
