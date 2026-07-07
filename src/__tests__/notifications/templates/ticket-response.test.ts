import { describe, it, expect } from 'vitest'
import {
  renderTicketResponse,
  shouldNotifyResident,
  type TicketResponseEmailData,
} from '@/lib/notifications/templates/ticket-response'

const baseData: TicketResponseEmailData = {
  client: {
    name: 'City of Kwinana',
    logo_light_url: null,
    primary_colour: '#293F52',
    email_footer_html: null,
  },
  ticketDisplayId: 'KWN-1234',
  ticketSubject: 'Missed green waste collection',
  categoryLabel: 'Service Issue',
  replyMessage: 'Thanks for getting in touch — we have rebooked your collection for next week.',
  ticketUrl: 'https://kwn.verco.au/contact/tickets/KWN-1234',
}

describe('renderTicketResponse', () => {
  it('subject names the enquiry and includes the display id', () => {
    const { subject } = renderTicketResponse(baseData)
    expect(subject).toBe('New reply to your enquiry [KWN-1234]')
  })

  it('renders the reply message', () => {
    const { html } = renderTicketResponse(baseData)
    expect(html).toContain('we have rebooked your collection')
  })

  it('HTML-escapes the reply message (injection safety)', () => {
    const { html } = renderTicketResponse({
      ...baseData,
      replyMessage: '<script>alert(1)</script>',
    })
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('converts reply newlines to <br>', () => {
    const { html } = renderTicketResponse({ ...baseData, replyMessage: 'Line one\nLine two' })
    expect(html).toContain('Line one<br>Line two')
  })

  it('includes the ticket details block (ref, subject, category)', () => {
    const { html } = renderTicketResponse(baseData)
    expect(html).toContain('KWN-1234')
    expect(html).toContain('Missed green waste collection')
    expect(html).toContain('Service Issue')
  })

  it('renders the CTA pointing at the ticket URL', () => {
    const { html } = renderTicketResponse(baseData)
    expect(html).toContain('https://kwn.verco.au/contact/tickets/KWN-1234')
    expect(html).toContain('View &amp; reply')
  })

  it('applies tenant branding (client name appears)', () => {
    const { html } = renderTicketResponse(baseData)
    expect(html).toContain('City of Kwinana')
  })
})

describe('shouldNotifyResident', () => {
  it('true for a public staff reply', () => {
    expect(shouldNotifyResident('staff', false)).toBe(true)
  })
  it('false for a resident reply', () => {
    expect(shouldNotifyResident('resident', false)).toBe(false)
  })
  it('false for a staff internal note', () => {
    expect(shouldNotifyResident('staff', true)).toBe(false)
  })
})
