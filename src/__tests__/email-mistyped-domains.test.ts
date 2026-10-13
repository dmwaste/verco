import { describe, it, expect } from 'vitest'
import { mistypedEmailDomainMessage } from '@/lib/email'
import { ContactSchema } from '@/lib/booking/schemas'

// 13/10/2026: staff booking on residents' behalf typed their own address with
// the wrong domain, and 55 Kwinana booking emails went to third-party domains.
describe('mistyped D&M staff email domains', () => {
  it.each([
    ['jo@dmwaste.com', 'dmwaste.com.au'],
    ['jo@dmwastemanagement.com', 'dmwastemanagement.com.au'],
    ['jo@verco.com', 'verco.au'],
    ['jo@verco.com.au', 'verco.au'],
    ['  Jo@VERCO.com  ', 'verco.au'],
  ])('rejects %s and suggests @%s', (email, fix) => {
    const msg = mistypedEmailDomainMessage(email)
    expect(msg).not.toBeNull()
    expect(msg).toContain(`@${fix}`)
  })

  it.each([
    'jo@dmwaste.com.au',
    'jo@dmwastemanagement.com.au',
    'jo@verco.au',
    'vergevalet@wmrc.wa.gov.au',
    'resident@gmail.com',
    'jo@myverco.com',
    'jo@verco.com.example.org',
    'not-an-email',
  ])('leaves %s alone', (email) => {
    expect(mistypedEmailDomainMessage(email)).toBeNull()
  })

  it('blocks the resident booking form with the suggestion', () => {
    const base = { first_name: 'Jo', last_name: 'Bloggs', mobile: '0412345678' }
    const bad = ContactSchema.safeParse({ ...base, email: 'jo@verco.com' })
    expect(bad.success).toBe(false)
    expect(JSON.stringify(bad.error?.issues)).toContain('@verco.au')
    expect(ContactSchema.safeParse({ ...base, email: 'jo@verco.au' }).success).toBe(true)
  })
})
