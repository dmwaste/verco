import { describe, it, expect } from 'vitest'
import { mudContactInput } from '../lib/contact-upsert'
import { planStrataAttach } from '../attach-mud-strata-contacts'

describe('mudContactInput', () => {
  it('applies the one-brain phone rule: mobiles → E.164, landlines stripped (never +618…)', () => {
    expect(mudContactInput({ contactName: 'Kendal Garnett', contactNumber: '0412 345 678', email: 'K@Abode.com.au' }))
      .toEqual({ email: 'k@abode.com.au', firstName: 'Kendal', lastName: 'Garnett', mobileE164: '+61412345678' })
    expect(mudContactInput({ contactName: 'Strata Office', contactNumber: '08 9368 2221', email: 'a@b.au' }).mobileE164).toBe('0893682221')
  })
  it('handles single-word and missing names/phones', () => {
    expect(mudContactInput({ contactName: 'Cygnet', contactNumber: null, email: 'c@d.au' }))
      .toEqual({ email: 'c@d.au', firstName: 'Cygnet', lastName: '', mobileE164: '' })
    expect(mudContactInput({ contactName: null, contactNumber: '', email: null }).email).toBeNull()
  })
})

describe('planStrataAttach', () => {
  const rec = (id: string, mudRef: string | null, email: string | null = 'x@y.au') =>
    ({ id, mudRef, contactName: 'A B', contactNumber: '0412345678', email })
  const prop = (id: string, mud_code: string, strata_contact_id: string | null = null) => ({ id, mud_code, strata_contact_id })

  it('plans an attach only for a unique Airtable row + a unique contact-less Verco row', () => {
    const { plans, skips } = planStrataAttach(
      [rec('recA', 'SOP-MUD-32'), rec('recB', 'SOP-MUD-58')],
      [prop('p1', 'SOP-MUD-32'), prop('p2', 'sop-mud-58 ')],
      ['SOP-MUD-32', 'SOP-MUD-58'],
    )
    expect(plans.map((p) => [p.ref, p.propertyId, p.recId])).toEqual([['SOP-MUD-32', 'p1', 'recA'], ['SOP-MUD-58', 'p2', 'recB']])
    expect(skips).toEqual([])
  })

  it('never overwrites a contact and never guesses between duplicates', () => {
    const { plans, skips } = planStrataAttach(
      [rec('r1', 'FRE-MUD-76'), rec('r2', 'FRE-MUD-76'), rec('r3', 'SOP-MUD-1'), rec('r4', 'SOP-MUD-2'), rec('r5', 'SOP-MUD-3', null)],
      [prop('p1', 'SOP-MUD-1', 'c-existing'), prop('p2', 'SOP-MUD-2'), prop('p3', 'SOP-MUD-2'), prop('p4', 'SOP-MUD-3')],
      ['FRE-MUD-76', 'SOP-MUD-1', 'SOP-MUD-2', 'SOP-MUD-3', 'SOP-MUD-99'],
    )
    expect(plans).toEqual([])
    expect(skips).toEqual([
      { ref: 'FRE-MUD-76', reason: 'ambiguous in Airtable (2 rows)' },
      { ref: 'SOP-MUD-1', reason: 'Verco property already has a strata contact' },
      { ref: 'SOP-MUD-2', reason: 'ambiguous in Verco (2 rows)' },
      { ref: 'SOP-MUD-3', reason: 'no email in Airtable' },
      { ref: 'SOP-MUD-99', reason: 'not in Airtable MUD List' },
    ])
  })
})
