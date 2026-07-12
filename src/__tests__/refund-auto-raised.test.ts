import { describe, it, expect } from 'vitest'
import {
  REFUND_REASONS,
  isAutoRaised,
  autoRaisedContext,
} from '@/lib/refunds/auto-raised'

// Every `refund_request` row is auto-raised by a staff-initiated state change
// that has ALREADY been applied (a staff cancellation, a quantity reduction, or
// an NCN/NP contractor-fault resolution) — there is no discretionary/resident
// refund-creation path. The amount is therefore genuinely owed, and rejecting a
// request is irreversible (no re-raise, no resident notification).
//
// These constants are the single source of truth shared by the three server
// orchestrators that WRITE the reason and the admin refunds table that CLASSIFIES
// it, so the writer and reader can never drift. This test locks that contract:
// if a new auto-raise reason is added to the orchestrators without registering
// it here, the classifier goes stale and this test should be the thing that
// catches it.

describe('isAutoRaised — the four owed-money reasons', () => {
  it.each(Object.values(REFUND_REASONS))('classifies %s as auto-raised', (reason) => {
    expect(isAutoRaised(reason)).toBe(true)
  })

  it('classifies an unknown / discretionary reason as NOT auto-raised', () => {
    expect(isAutoRaised('Resident requested goodwill refund')).toBe(false)
  })

  it('is null/empty-safe', () => {
    expect(isAutoRaised(null)).toBe(false)
    expect(isAutoRaised(undefined)).toBe(false)
    expect(isAutoRaised('')).toBe(false)
  })

  it('does not partial-match a superstring of a known reason', () => {
    expect(isAutoRaised('Booking cancelled by staff (see notes)')).toBe(false)
  })
})

describe('autoRaisedContext — dialog phrase per reason', () => {
  it('returns a distinct plain-language phrase for every known reason', () => {
    const phrases = Object.values(REFUND_REASONS).map((r) => autoRaisedContext(r))
    // every known reason yields a non-null phrase...
    expect(phrases.every((p) => p !== null && p.length > 0)).toBe(true)
    // ...and each phrase is distinct (no copy-paste collision)
    expect(new Set(phrases).size).toBe(phrases.length)
  })

  it('returns null for an unknown reason so the dialog falls back to generic copy', () => {
    expect(autoRaisedContext('Resident requested goodwill refund')).toBeNull()
    expect(autoRaisedContext(null)).toBeNull()
  })
})
