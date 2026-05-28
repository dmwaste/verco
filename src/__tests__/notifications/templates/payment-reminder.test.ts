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
    expect(html).toContain(`https://verco.test/kwn/booking/${encodeURIComponent(booking.ref)}`)
    expect(html).toContain('Complete payment')
  })
})
