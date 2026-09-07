/**
 * Email canonicalisation (#575).
 *
 * Ben could not add Hazel Bone as Kwinana client-staff: she had already
 * self-registered on the resident portal, so auth matched her address
 * case-insensitively while the create-user EF's profiles lookup matched it
 * byte-exactly — leaving "exists in auth but has no profile" with no way forward.
 */
import { describe, it, expect } from 'vitest'
import { normaliseEmail, emailMatchPattern } from '@/lib/email'

describe('normaliseEmail', () => {
  it('lowercases so a typed address matches what GoTrue stored', () => {
    expect(normaliseEmail('Hazel.Bone@kwinana.wa.gov.au')).toBe('hazel.bone@kwinana.wa.gov.au')
  })

  it('trims whitespace pasted in from a directory or email client', () => {
    expect(normaliseEmail('  hazel.bone@kwinana.wa.gov.au \n')).toBe('hazel.bone@kwinana.wa.gov.au')
  })

  it('leaves an already-canonical address untouched', () => {
    expect(normaliseEmail('hazel.bone@kwinana.wa.gov.au')).toBe('hazel.bone@kwinana.wa.gov.au')
  })
})

describe('emailMatchPattern', () => {
  it('normalises case so a lookup finds a mixed-case stored row', () => {
    expect(emailMatchPattern('Hazel.Bone@kwinana.wa.gov.au')).toBe('hazel.bone@kwinana.wa.gov.au')
  })

  it('escapes underscores so they cannot act as single-character wildcards', () => {
    expect(emailMatchPattern('first_last@example.com')).toBe('first\\_last@example.com')
  })

  it('escapes percent signs so they cannot act as multi-character wildcards', () => {
    expect(emailMatchPattern('a%b@example.com')).toBe('a\\%b@example.com')
  })

  it('escapes a literal backslash without double-escaping the rest', () => {
    expect(emailMatchPattern('a\\_b@example.com')).toBe('a\\\\\\_b@example.com')
  })
})
