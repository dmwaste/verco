import { describe, it, expect } from 'vitest'
import {
  CONCURRENT_EDIT_MARKER,
  mapEditErrorToStatus,
} from '@/lib/booking/edit-error-mapping'

// Unit coverage for the inline-quantity-edit error taxonomy (#387.1). The
// create-booking EF routes `update_booking_items_in_place` errors through this
// map to pick the HTTP status; the concurrent-edit marker MUST resolve to a
// retryable 409 so the admin reloads instead of seeing a hard failure.

describe('mapEditErrorToStatus', () => {
  it('maps a booking-not-found error to 404 with no code', () => {
    const r = mapEditErrorToStatus('Booking not found: 9a1f6f2e-…')
    expect(r).toEqual({ status: 404 })
  })

  it('maps the concurrent-edit marker to 409 with code concurrent_edit', () => {
    // The RPC RAISEs three variants (status / items / date), all carrying the
    // shared marker — each must resolve to the same retryable conflict.
    for (const raise of [
      'Booking status changed since this edit was priced (concurrent edit) — reload and try again',
      'Booking items changed since this edit was priced (concurrent edit) — reload and try again',
      'Booking date changed since this edit was priced (concurrent edit) — reload and try again',
    ]) {
      expect(raise).toContain(CONCURRENT_EDIT_MARKER)
      expect(mapEditErrorToStatus(raise)).toEqual({ status: 409, code: 'concurrent_edit' })
    }
  })

  it('maps any other message to 500 with no code', () => {
    const r = mapEditErrorToStatus('deadlock detected')
    expect(r).toEqual({ status: 500 })
  })

  it('does not misclassify a capacity shortfall (the EF handles Insufficient before this map)', () => {
    // "Insufficient …" is not part of this taxonomy — it falls through to 500
    // here, and the EF matches it with a dedicated 409 branch upstream.
    expect(mapEditErrorToStatus('Insufficient bulk capacity on collection date')).toEqual({
      status: 500,
    })
  })
})
