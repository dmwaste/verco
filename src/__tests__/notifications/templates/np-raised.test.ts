import { describe, it, expect } from 'vitest'
import { renderNpRaised } from '@/lib/notifications/templates/np-raised'
import { makeMockBooking } from '../fixtures'

const APP_URL = 'https://verco.test'

describe('renderNpRaised', () => {
  it('returns a subject containing the booking reference', () => {
    const booking = makeMockBooking({ ref: 'VV-NP001' })
    const { subject } = renderNpRaised(booking, APP_URL, {})
    expect(subject).toBe('Nothing presented — VV-NP001')
  })

  it('renders standard copy when contractor_fault is false or absent', () => {
    const booking = makeMockBooking()
    const { html } = renderNpRaised(booking, APP_URL, {})
    expect(html).toContain('no items were found on the verge')
    expect(html).not.toContain('unable to attend')
  })

  it('renders softer copy when contractor_fault is true', () => {
    const booking = makeMockBooking()
    const { html } = renderNpRaised(booking, APP_URL, { contractor_fault: true })
    expect(html).toContain('unable to attend your address')
    expect(html).not.toContain('no items were found')
  })

  it('renders notes when present, omits when absent', () => {
    const booking = makeMockBooking()
    const withNotes = renderNpRaised(booking, APP_URL, { notes: 'No waste visible' })
    expect(withNotes.html).toContain('No waste visible')

    const withoutNotes = renderNpRaised(booking, APP_URL, {})
    expect(withoutNotes.html).not.toContain('Notes')
  })

  it('includes the dispute window copy', () => {
    const booking = makeMockBooking()
    const { html } = renderNpRaised(booking, APP_URL, {})
    expect(html).toContain('14 days')
    expect(html).toContain('dispute')
  })

  it('CTA resolves to the tenant host, not a root-host path segment', () => {
    const booking = makeMockBooking({ ref: 'VV-NP009' })
    booking.client.slug = 'kwn'
    const { html } = renderNpRaised(booking, APP_URL, {})
    // Hostname-based tenant routing — `${appUrl}/${slug}/...` 404s to /landing.
    expect(html).toContain(`https://kwn.verco.au/booking/${encodeURIComponent('VV-NP009')}`)
    expect(html).not.toContain('verco.test/kwn/booking')
  })
})
