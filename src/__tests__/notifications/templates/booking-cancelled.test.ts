import { describe, it, expect } from 'vitest'
import { renderBookingCancelled } from '@/lib/notifications/templates/booking-cancelled'
import { makeMockBooking, makeMockPaidBooking } from '../fixtures'

const APP_URL = 'https://verco.test'

describe('renderBookingCancelled', () => {
  it('returns a subject containing the booking reference', () => {
    const booking = makeMockBooking({ ref: 'VV-CAN001' })
    const { subject } = renderBookingCancelled(booking, APP_URL)
    expect(subject).toBe('Booking cancelled — VV-CAN001')
  })

  it('renders the booking details without a reason block when no reason is provided', () => {
    const booking = makeMockBooking({ ref: 'VV-CAN002' })
    const { html } = renderBookingCancelled(booking, APP_URL)
    expect(html).toContain('VV-CAN002')
    expect(html).toContain('has been cancelled')
    expect(html).not.toContain('<strong>Reason:</strong>')
  })

  it('renders the reason block when a cancellation reason is provided', () => {
    const booking = makeMockBooking({ ref: 'VV-CAN003' })
    const { html } = renderBookingCancelled(booking, APP_URL, {
      reason: 'Contractor equipment breakdown',
    })
    expect(html).toContain('<strong>Reason:</strong>')
    expect(html).toContain('Contractor equipment breakdown')
  })

  it('renders a refund notice when the booking had paid extras', () => {
    const booking = makeMockPaidBooking()
    const { html } = renderBookingCancelled(booking, APP_URL, {
      refund_status: 'processed',
    })
    expect(html).toContain('refund of')
    expect(html).toContain('$55.00')
    expect(html).toContain('1–3 business days')
  })

  it('omits the refund notice when the booking was free', () => {
    const booking = makeMockBooking({ total_charge_cents: 0 })
    const { html } = renderBookingCancelled(booking, APP_URL)
    expect(html).not.toContain('refund of')
  })

  it('HTML-escapes the reason field to prevent injection', () => {
    const booking = makeMockBooking()
    const { html } = renderBookingCancelled(booking, APP_URL, {
      reason: '<script>alert(1)</script>',
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('renders "pending review" copy when refund_status is pending_review on a paid booking', () => {
    const booking = makeMockPaidBooking()
    const { html } = renderBookingCancelled(booking, APP_URL, {
      refund_status: 'pending_review',
    })
    expect(html).toContain('reviewed by our team')
    expect(html).toContain('$55.00')
    expect(html).not.toContain('has been processed')
  })

  it('renders "processed" copy when refund_status is processed on a paid booking', () => {
    const booking = makeMockPaidBooking()
    const { html } = renderBookingCancelled(booking, APP_URL, {
      refund_status: 'processed',
    })
    expect(html).toContain('has been processed')
    expect(html).toContain('$55.00')
    expect(html).not.toContain('reviewed by our team')
  })

  it('omits refund copy when paid booking has no refund_status (backwards compat)', () => {
    const booking = makeMockPaidBooking()
    const { html } = renderBookingCancelled(booking, APP_URL)
    expect(html).not.toContain('refund of')
    expect(html).not.toContain('reviewed by our team')
    expect(html).not.toContain('has been processed')
  })

  it('CTA resolves to the tenant host, not a root-host path segment', () => {
    const booking = makeMockBooking()
    booking.client.slug = 'kwn'
    const { html } = renderBookingCancelled(booking, APP_URL)
    // Hostname-based tenant routing — `${appUrl}/${slug}/...` 404s to /landing.
    expect(html).toContain('https://kwn.verco.au/dashboard')
    expect(html).not.toContain('verco.test/kwn/dashboard')
  })
})
