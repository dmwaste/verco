import { describe, it, expect } from 'vitest'
import { renderCompletionSurvey } from '@/lib/notifications/templates/completion-survey'
import { makeMockBooking, mockClientMinimal } from '../fixtures'

const APP_URL = 'https://verco.test'

describe('renderCompletionSurvey', () => {
  it('returns a subject containing the booking reference', () => {
    const booking = makeMockBooking({ ref: 'VV-DONE01' })
    const { subject } = renderCompletionSurvey(booking, APP_URL, 'tok-abc-123')
    expect(subject).toBe('How was your collection? — VV-DONE01')
  })

  it('renders completion confirmation and feedback ask', () => {
    const booking = makeMockBooking()
    const { html } = renderCompletionSurvey(booking, APP_URL, 'tok-abc-123')
    expect(html).toContain('collection is complete')
    expect(html).toContain('feedback')
  })

  it('CTA links to the survey URL with the token', () => {
    const booking = makeMockBooking()
    booking.client.slug = 'kwn'
    const { html } = renderCompletionSurvey(booking, APP_URL, 'my-survey-token')
    // Hostname-based tenant routing — resolve to the tenant host, not a path
    // segment on the root host.
    expect(html).toContain('https://kwn.verco.au/survey/my-survey-token')
    expect(html).not.toContain('verco.test/kwn/survey')
    expect(html).toContain('Complete survey')
  })

  it('does not contain dispute, reason, or photo blocks', () => {
    // Use a logo-less client so the layout header is a <span> not an <img>,
    // allowing the assertion to confirm the template emits no photo blocks.
    const booking = makeMockBooking({ client: { slug: 'mock-tenant', custom_domain: null, reply_to_email: 'noreply@mock.wa.gov.au', email_from_name: 'Test', twilio_messaging_service_sid: null, ...mockClientMinimal } })
    const { html } = renderCompletionSurvey(booking, APP_URL, 'tok-abc-123')
    expect(html).not.toContain('dispute')
    expect(html).not.toContain('Reason')
    expect(html).not.toContain('<img')
  })
})
