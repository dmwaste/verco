import { describe, it, expect } from 'vitest'
import { renderNcnRaised } from '@/lib/notifications/templates/ncn-raised'
import { makeMockBooking } from '../fixtures'

const APP_URL = 'https://verco.test'

describe('renderNcnRaised', () => {
  it('returns a subject containing the booking reference', () => {
    const booking = makeMockBooking({ ref: 'VV-NCN001' })
    const { subject } = renderNcnRaised(booking, APP_URL, { reason: 'Building Waste' })
    expect(subject).toBe('Non-conformance notice — VV-NCN001')
  })

  it('renders standard copy when contractor_fault is false or absent', () => {
    const booking = makeMockBooking()
    const { html } = renderNcnRaised(booking, APP_URL, { reason: 'Building Waste' })
    expect(html).toContain('non-conformance notice has been issued')
    expect(html).not.toContain('unable to complete')
  })

  it('renders softer copy when contractor_fault is true', () => {
    const booking = makeMockBooking()
    const { html } = renderNcnRaised(booking, APP_URL, {
      reason: 'Building Waste',
      contractor_fault: true,
    })
    expect(html).toContain('unable to complete your collection')
    expect(html).not.toContain('non-conformance notice has been issued')
  })

  it('renders the reason block with HTML escaping', () => {
    const booking = makeMockBooking()
    const { html } = renderNcnRaised(booking, APP_URL, {
      reason: '<script>alert(1)</script>',
    })
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('renders notes when present, omits when absent', () => {
    const booking = makeMockBooking()
    const withNotes = renderNcnRaised(booking, APP_URL, {
      reason: 'Building Waste',
      notes: 'Items behind fence',
    })
    expect(withNotes.html).toContain('Items behind fence')

    const withoutNotes = renderNcnRaised(booking, APP_URL, {
      reason: 'Building Waste',
    })
    expect(withoutNotes.html).not.toContain('Notes')
  })

  it('renders photos as inline <img> (max 4, clickable), omits when empty', () => {
    const booking = makeMockBooking()
    const photos = [
      'https://cdn.example.com/1.jpg',
      'https://cdn.example.com/2.jpg',
      'https://cdn.example.com/3.jpg',
      'https://cdn.example.com/4.jpg',
      'https://cdn.example.com/5.jpg',
    ]
    const { html } = renderNcnRaised(booking, APP_URL, {
      reason: 'Building Waste',
      photos,
    })
    expect(html).toContain('cdn.example.com/1.jpg')
    expect(html).toContain('cdn.example.com/4.jpg')
    expect(html).not.toContain('cdn.example.com/5.jpg')
    // Real <img> tags, each wrapped in a link to full-res — NOT a CSS
    // background-image (Gmail/Outlook strip that, leaving an empty box).
    expect(html).toContain('<img src="https://cdn.example.com/1.jpg"')
    expect(html).toContain('href="https://cdn.example.com/1.jpg"')
    expect(html).not.toContain('center/cover')
    expect(html).not.toContain('background:#F8F9FA url')

    const noPhotos = renderNcnRaised(booking, APP_URL, { reason: 'Building Waste' })
    expect(noPhotos.html).not.toContain('<img')
  })

  it('CTA resolves to the tenant host, not a root-host path segment', () => {
    const booking = makeMockBooking({ ref: 'VV-NCN009' })
    booking.client.slug = 'kwn'
    const { html } = renderNcnRaised(booking, APP_URL, { reason: 'Building Waste' })
    // Hostname-based tenant routing — `${appUrl}/${slug}/...` 404s to /landing.
    expect(html).toContain(`https://kwn.verco.au/booking/${encodeURIComponent('VV-NCN009')}`)
    expect(html).not.toContain('verco.test/kwn/booking')
  })

  describe('City of Kwinana compliance directive', () => {
    it('appends the Kwinana infringement notice for kwn resident-fault NCNs', () => {
      const booking = makeMockBooking()
      booking.client.slug = 'kwn'
      const { html } = renderNcnRaised(booking, APP_URL, { reason: 'Building Waste' })
      expect(html).toContain('$400 infringement under section 2.10(1)')
      expect(html).toContain('City of Kwinana Waste Local Law 2022')
      expect(html).toContain('7 days of this notice')
      expect(html).toContain('Emma Gillham')
      expect(html).toContain('Waste Management Officer')
    })

    it('uses the corrected contact URL and collection wording, not the supplied typos', () => {
      const booking = makeMockBooking()
      booking.client.slug = 'kwn'
      const { html } = renderNcnRaised(booking, APP_URL, { reason: 'Building Waste' })
      // Two fixes approved alongside the copy: verco.au (not .com), /contact
      // (not the non-existent /contact-us), and "collection" (not "collation").
      expect(html).toContain('https://kwn.verco.au/contact')
      expect(html).toContain('arrange an additional collection at')
      expect(html).not.toContain('verco.com')
      expect(html).not.toContain('contact-us')
      expect(html).not.toContain('collation')
    })

    it('omits the Kwinana directive for other tenants', () => {
      const booking = makeMockBooking() // default slug 'mock-tenant'
      const { html } = renderNcnRaised(booking, APP_URL, { reason: 'Building Waste' })
      expect(html).not.toContain('$400 infringement')
      expect(html).not.toContain('Emma Gillham')
      expect(html).not.toContain('Waste Local Law 2022')
    })

    it('suppresses the infringement warning on contractor-fault Kwinana NCNs', () => {
      const booking = makeMockBooking()
      booking.client.slug = 'kwn'
      const { html } = renderNcnRaised(booking, APP_URL, {
        reason: 'Collection Limit Exceeded',
        contractor_fault: true,
      })
      // Contractor fault → softer intro, no fine threat, no signature.
      expect(html).toContain('unable to complete your collection')
      expect(html).not.toContain('$400 infringement')
      expect(html).not.toContain('Emma Gillham')
    })
  })

  describe('service type row', () => {
    it('renders a "Service type" row with the booked service label(s)', () => {
      const booking = makeMockBooking()
      const { html } = renderNcnRaised(booking, APP_URL, {
        reason: 'Building Waste',
        serviceLabel: 'E-Waste, Mattress',
      })
      expect(html).toContain('Service type')
      expect(html).toContain('E-Waste, Mattress')
    })

    it('omits the row entirely when no service label is provided', () => {
      const booking = makeMockBooking()
      const { html } = renderNcnRaised(booking, APP_URL, { reason: 'Building Waste' })
      expect(html).not.toContain('Service type')
    })

    it('escapes a hostile service name (no raw HTML injection)', () => {
      const booking = makeMockBooking()
      const { html } = renderNcnRaised(booking, APP_URL, {
        reason: 'Building Waste',
        serviceLabel: '<img src=x onerror=alert(1)>',
      })
      expect(html).not.toContain('<img src=x onerror=alert(1)>')
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    })
  })
})
