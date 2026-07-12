import { describe, it, expect } from 'vitest'
import { renderBookingUpdated } from '@/lib/notifications/templates/booking-updated'
import { makeMockBooking, makeMockPaidBooking } from '../fixtures'

const APP_URL = 'https://verco.test'

describe('renderBookingUpdated', () => {
  it('returns a subject containing the booking reference', () => {
    const booking = makeMockBooking({ ref: 'VV-UPD001' })
    const { subject } = renderBookingUpdated(booking, APP_URL)
    expect(subject).toBe('Booking updated — VV-UPD001')
  })

  it('renders a current-state snapshot (ref, address, updated heading)', () => {
    const booking = makeMockBooking({ ref: 'VV-UPD002' })
    const { html } = renderBookingUpdated(booking, APP_URL)
    expect(html).toContain('VV-UPD002')
    expect(html).toContain('has been updated')
    expect(html).toContain('Booking updated')
  })

  it('renders the "processed" refund line keyed on the reduction delta, not the total', () => {
    const booking = makeMockPaidBooking() // total $55.00
    const { html } = renderBookingUpdated(booking, APP_URL, {
      refundCents: 5000,
      refundStatus: 'processed',
    })
    // The refund line shows the delta ($50), distinct from the "Total paid"
    // snapshot line which shows the booking's current total ($55).
    expect(html).toContain('A refund of <strong>$50.00</strong>')
    expect(html).toContain('has been processed')
    // Context-neutral copy — booking_updated is now reused by NCN/NP resolution
    // refunds where nothing was "removed", so the phrase must not assume it.
    expect(html).not.toContain('removed items')
  })

  it('renders the "pending review" refund line without an unfulfillable follow-up promise', () => {
    const booking = makeMockPaidBooking()
    const { html } = renderBookingUpdated(booking, APP_URL, {
      refundCents: 5000,
      refundStatus: 'pending_review',
    })
    expect(html).toContain('A refund of <strong>$50.00</strong>')
    expect(html).toContain('has been requested')
    // No code path fires when a queued refund is later approved, so the copy
    // must not promise a follow-up ("We'll be in touch once it's processed").
    expect(html).not.toContain("We'll be in touch")
    expect(html).not.toContain('reviewed by our team')
    expect(html).not.toContain('has been processed')
    expect(html).not.toContain('removed items')
  })

  it('omits the refund line when no refund accompanies the edit (e.g. a date change)', () => {
    const booking = makeMockPaidBooking()
    const { html } = renderBookingUpdated(booking, APP_URL)
    expect(html).not.toContain('refund of')
  })

  it('omits the refund line when a status is set but the delta is zero', () => {
    const booking = makeMockPaidBooking()
    const { html } = renderBookingUpdated(booking, APP_URL, { refundCents: 0, refundStatus: 'processed' })
    expect(html).not.toContain('refund of')
  })

  it('CTA resolves to the tenant host booking page, not a root-host path segment', () => {
    const booking = makeMockBooking({ ref: 'KWN-UPD9' })
    booking.client.slug = 'kwn'
    const { html } = renderBookingUpdated(booking, APP_URL)
    expect(html).toContain('https://kwn.verco.au/booking/KWN-UPD9')
    expect(html).not.toContain('verco.test/kwn/booking')
  })
})
