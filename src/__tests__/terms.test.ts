import { describe, it, expect } from 'vitest'
import { clientHasTerms } from '@/lib/booking/terms'

describe('clientHasTerms', () => {
  it('returns false for null, undefined, empty, and whitespace-only', () => {
    expect(clientHasTerms(null)).toBe(false)
    expect(clientHasTerms(undefined)).toBe(false)
    expect(clientHasTerms('')).toBe(false)
    expect(clientHasTerms('   ')).toBe(false)
    // tabs/newlines must also count as empty (matches SQL `~ '\S'`, NOT btrim)
    expect(clientHasTerms('\t\n  ')).toBe(false)
  })

  it('returns true for real content, including padded', () => {
    expect(clientHasTerms('## Terms')).toBe(true)
    expect(clientHasTerms('  hi  ')).toBe(true)
  })
})
