import { describe, it, expect } from 'vitest'
import { renderBookingCreated } from '@/lib/notifications/templates/booking-created'
import { makeMockBooking, makeMockPaidBooking } from '../fixtures'

const APP_URL = 'https://verco.test'

describe('renderBookingCreated', () => {
  it('returns a subject containing the booking reference', () => {
    const booking = makeMockBooking({ ref: 'VV-MZZ123' })
    const { subject } = renderBookingCreated(booking, APP_URL)
    expect(subject).toBe('Booking confirmed — VV-MZZ123')
  })

  it('includes the booking reference, address, and formatted collection date in the body', () => {
    const booking = makeMockBooking({
      ref: 'VV-AAA999',
      address: '42 Test Lane, Wellard WA 6170',
      collection_date: '2026-04-15',
    })
    const { html } = renderBookingCreated(booking, APP_URL)
    expect(html).toContain('VV-AAA999')
    expect(html).toContain('42 Test Lane, Wellard WA 6170')
    expect(html).toContain('Wed, 15 Apr 2026')
  })

  it('renders a details row for each distinct service with quantities', () => {
    const booking = makeMockBooking({
      items: [
        { service_name: 'General', no_services: 3, is_extra: false, line_charge_cents: 0 },
        { service_name: 'Green Waste', no_services: 1, is_extra: false, line_charge_cents: 0 },
      ],
    })
    const { html } = renderBookingCreated(booking, APP_URL)
    expect(html).toContain('General')
    expect(html).toContain('3 included')
    expect(html).toContain('Green Waste')
    expect(html).toContain('1 included')
  })

  it('distinguishes free included units from paid extras in the details table', () => {
    const booking = makeMockPaidBooking()
    const { html } = renderBookingCreated(booking, APP_URL)
    expect(html).toContain('2 included')
    expect(html).toContain('1 paid')
    expect(html).toContain('$55.00')
  })

  it('renders the total paid row only when total_charge_cents > 0', () => {
    const free = makeMockBooking({ total_charge_cents: 0 })
    const { html: freeHtml } = renderBookingCreated(free, APP_URL)
    expect(freeHtml).not.toContain('Total paid')

    const paid = makeMockPaidBooking()
    const { html: paidHtml } = renderBookingCreated(paid, APP_URL)
    expect(paidHtml).toContain('Total paid')
    expect(paidHtml).toContain('$55.00')
  })

  it('falls back to {slug}.verco.au when client has no custom_domain', () => {
    // Default fixture has client.slug='mock-tenant', custom_domain=null.
    // Verco uses hostname-based tenant routing — appUrl + slug paths are broken.
    const booking = makeMockBooking({ ref: 'VV-BBB777' })
    const { html } = renderBookingCreated(booking, APP_URL)
    expect(html).toContain('https://mock-tenant.verco.au/booking/VV-BBB777')
  })

  it('uses client.custom_domain when set (preferred over slug fallback)', () => {
    const booking = makeMockBooking({
      ref: 'VV-CCC888',
      client: {
        slug: 'verge-valet',
        custom_domain: 'vvtest.verco.au',
        name: 'Verge Valet',
        logo_light_url: null,
        primary_colour: null,
        email_footer_html: null,
        reply_to_email: null,
        email_from_name: null,
        twilio_messaging_service_sid: null,
      },
    })
    const { html } = renderBookingCreated(booking, APP_URL)
    expect(html).toContain('https://vvtest.verco.au/booking/VV-CCC888')
    expect(html).not.toContain('verge-valet.verco.au')
  })

  it('renders a Services section header above the line items', () => {
    const booking = makeMockBooking({ ref: 'VV-DDD999' })
    const { html } = renderBookingCreated(booking, APP_URL)
    expect(html).toContain('>Services</td>')
  })

  it('HTML-escapes the booking reference and address in the body', () => {
    const booking = makeMockBooking({
      ref: 'VV-<script>',
      address: '<iframe src=evil>',
    })
    const { html } = renderBookingCreated(booking, APP_URL)
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<iframe')
    expect(html).toContain('VV-&lt;script&gt;')
    expect(html).toContain('&lt;iframe src=evil&gt;')
  })
})
