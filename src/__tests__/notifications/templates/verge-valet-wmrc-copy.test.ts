import { describe, it, expect } from 'vitest'
import { renderBookingCreated } from '@/lib/notifications/templates/booking-created'
import { renderNcnRaised } from '@/lib/notifications/templates/ncn-raised'
import { makeMockBooking } from '../fixtures'

/**
 * WMRC's own wording for the Verge Valet confirmation and non-conformance
 * emails (supplied 15/09/2026, approved for the 01/10 cutover). These tests
 * pin the copy WMRC signed off and, just as importantly, prove no other tenant
 * picked it up — the templates are shared across every council.
 */

const APP_URL = 'https://verco.test'

const vvBooking = (overrides = {}) => {
  const b = makeMockBooking(overrides)
  return {
    ...b,
    client: { ...b.client, slug: 'vergevalet', custom_domain: 'vvtest.verco.au' },
  }
}

describe('Verge Valet booking confirmation (WMRC copy)', () => {
  it('leads with "You\'re all set!" and WMRC\'s opening line', () => {
    const { html } = renderBookingCreated(vvBooking(), APP_URL)
    // The heading goes through escapeHtml, so the apostrophe is encoded.
    expect(html).toContain('You&#39;re all set!')
    expect(html).toContain('Thank you for booking your Verge Valet collection')
  })

  it('tells residents NOT to place items out until the place-out SMS', () => {
    const { html } = renderBookingCreated(vvBooking(), APP_URL)
    expect(html).toContain("Please don't place your items on the verge yet")
    expect(html).toContain('approximately 3 days before your scheduled collection date')
  })

  it('links the FAQs, the contact form, and names the call centre', () => {
    const { html } = renderBookingCreated(vvBooking(), APP_URL)
    expect(html).toContain('https://vvtest.verco.au/contact#faqs')
    expect(html).toContain('https://vvtest.verco.au/contact')
    expect(html).toContain('9384 6711')
  })

  it('carries the do-not-reply line and the WMRC green, and drops the generic line', () => {
    const { html } = renderBookingCreated(vvBooking(), APP_URL)
    expect(html).toContain('Please do not respond to this email')
    expect(html).toContain('#72b75c')
    expect(html).not.toContain("You'll get another email closer to the date")
  })

  it('still shows reference, date, address and services', () => {
    const { html } = renderBookingCreated(
      vvBooking({ ref: 'SOP-TEST01', address: '1 Test St, South Perth WA 6151' }),
      APP_URL,
    )
    expect(html).toContain('SOP-TEST01')
    expect(html).toContain('1 Test St, South Perth WA 6151')
    expect(html).toContain('Wed, 15 Apr 2026')
    expect(html).toContain('General')
  })

  it('leaves other tenants on the generic confirmation', () => {
    const { html } = renderBookingCreated(makeMockBooking(), APP_URL)
    expect(html).toContain('Booking confirmed')
    expect(html).toContain("You'll get another email closer to the date")
    expect(html).not.toContain('9384 6711')
    expect(html).not.toContain('#72b75c')
  })
})

describe('Verge Valet non-conformance notice (WMRC copy)', () => {
  it('drops the 14-day dispute sentence and uses WMRC\'s wording', () => {
    const { html } = renderNcnRaised(vvBooking(), APP_URL, { reason: 'Building Waste' })
    expect(html).not.toContain('14 days from the date of this notice')
    expect(html).toContain('this non-conformance remains outstanding and requires attention')
    expect(html).toContain('some circumstances may be outside your control')
  })

  it('points residents at the FAQs, the contact form and the call centre', () => {
    const { html } = renderNcnRaised(vvBooking(), APP_URL, { reason: 'Building Waste' })
    expect(html).toContain('https://vvtest.verco.au/contact#faqs')
    expect(html).toContain('9384 6711')
  })

  it('keeps the 14-day line for every other tenant', () => {
    const { html } = renderNcnRaised(makeMockBooking(), APP_URL, { reason: 'Building Waste' })
    expect(html).toContain('You have 14 days from the date of this notice to dispute it.')
    expect(html).not.toContain('remains outstanding and requires attention')
  })

  it('does not disturb the Kwinana infringement block', () => {
    const b = makeMockBooking()
    const kwn = { ...b, client: { ...b.client, slug: 'kwn' } }
    const { html } = renderNcnRaised(kwn, APP_URL, { reason: 'Building Waste' })
    expect(html).toContain('Waste Local Law 2022')
    expect(html).toContain('You have 14 days from the date of this notice to dispute it.')
  })
})
