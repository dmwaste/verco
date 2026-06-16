import { describe, it, expect } from 'vitest'
import { renderPaymentReminder } from '@/lib/notifications/templates/payment-reminder'
import { makeMockPaidBooking } from '../fixtures'

const APP_URL = 'https://verco.test'

describe('renderPaymentReminder', () => {
  it('returns a subject containing the booking reference', () => {
    const booking = makeMockPaidBooking()
    const { subject } = renderPaymentReminder(booking, APP_URL)
    expect(subject).toContain(booking.ref)
    expect(subject).toContain('Complete your booking')
  })

  it('renders the amount due from total_charge_cents', () => {
    const booking = makeMockPaidBooking()
    const { html } = renderPaymentReminder(booking, APP_URL)
    expect(html).toContain('$55.00')
    expect(html).toContain('payment')
  })

  it('CTA links to the booking detail page', () => {
    const booking = makeMockPaidBooking()
    booking.client.slug = 'kwn'
    const { html } = renderPaymentReminder(booking, APP_URL)
    // Tenant routing is hostname-based — the CTA must resolve to the tenant
    // host, NOT a path segment on the root host (which 404s to /landing).
    expect(html).toContain(`https://kwn.verco.au/booking/${encodeURIComponent(booking.ref)}`)
    expect(html).not.toContain('verco.test/kwn/booking')
    expect(html).toContain('Complete payment')
  })
})
