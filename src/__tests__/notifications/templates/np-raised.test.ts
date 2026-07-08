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

  it('renders photos as inline <img> (max 4, clickable), omits when empty', () => {
    const booking = makeMockBooking()
    const photos = [
      'https://cdn.example.com/a.jpg',
      'https://cdn.example.com/b.jpg',
      'https://cdn.example.com/c.jpg',
      'https://cdn.example.com/d.jpg',
      'https://cdn.example.com/e.jpg',
    ]
    const { html } = renderNpRaised(booking, APP_URL, { photos })
    expect(html).toContain('<img src="https://cdn.example.com/a.jpg"')
    expect(html).toContain('href="https://cdn.example.com/a.jpg"')
    expect(html).toContain('cdn.example.com/d.jpg')
    expect(html).not.toContain('cdn.example.com/e.jpg')
    // Outlook-safe fixed pixel width (Word renderer ignores CSS max-width).
    expect(html).toContain('width="536"')

    // Photo-block-specific marker (not a bare '<img>' check, which would
    // false-fail if the layout ever adds a tenant logo image).
    const noPhotos = renderNpRaised(booking, APP_URL, {})
    expect(noPhotos.html).not.toContain('alt="Collection photo')
  })

  it('renders the Still to come line for pending sibling passes, omits otherwise', () => {
    const booking = makeMockBooking()
    const withPending = renderNpRaised(booking, APP_URL, { pendingServices: 'Green Waste' })
    expect(withPending.html).toContain('Still to come:')
    expect(withPending.html).toContain('Green Waste')

    const withoutPending = renderNpRaised(booking, APP_URL, {})
    expect(withoutPending.html).not.toContain('Still to come:')
  })

  describe('service type row', () => {
    it('renders a "Service type" row with the booked service label', () => {
      const booking = makeMockBooking()
      const { html } = renderNpRaised(booking, APP_URL, { serviceLabel: 'Bulk Waste' })
      expect(html).toContain('Service type')
      expect(html).toContain('Bulk Waste')
    })

    it('omits the row entirely when no service label is provided', () => {
      const booking = makeMockBooking()
      const { html } = renderNpRaised(booking, APP_URL, {})
      expect(html).not.toContain('Service type')
    })

    it('escapes a hostile service name (no raw HTML injection)', () => {
      const booking = makeMockBooking()
      const { html } = renderNpRaised(booking, APP_URL, {
        serviceLabel: '<img src=x onerror=alert(1)>',
      })
      expect(html).not.toContain('<img src=x onerror=alert(1)>')
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    })
  })
})
