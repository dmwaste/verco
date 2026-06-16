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

  it('renders photo thumbnails when present (max 4), omits when empty', () => {
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
})
