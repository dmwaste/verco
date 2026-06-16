import { describe, it, expect } from 'vitest'
import { renderPaymentExpired } from '@/lib/notifications/templates/payment-expired'
import { makeMockPaidBooking } from '../fixtures'

const APP_URL = 'https://verco.test'

describe('renderPaymentExpired', () => {
  it('returns a subject containing the booking reference', () => {
    const booking = makeMockPaidBooking()
    const { subject } = renderPaymentExpired(booking, APP_URL)
    expect(subject).toContain(booking.ref)
    expect(subject).toContain('Booking expired')
  })

  it('renders the no-charge notice', () => {
    const booking = makeMockPaidBooking()
    const { html } = renderPaymentExpired(booking, APP_URL)
    expect(html).toContain('No charge has been made')
    expect(html).toContain('expired')
  })

  it('CTA links to the dashboard for rebooking', () => {
    const booking = makeMockPaidBooking()
    booking.client.slug = 'kwn'
    const { html } = renderPaymentExpired(booking, APP_URL)
    // Hostname-based tenant routing — resolve to the tenant host, not a path
    // segment on the root host.
    expect(html).toContain('https://kwn.verco.au/dashboard')
    expect(html).not.toContain('verco.test/kwn/dashboard')
    expect(html).toContain('Book again')
  })
})
