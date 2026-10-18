import { describe, it, expect } from 'vitest'
import {
  phoneLookupCandidates,
  formatPhoneDisplay,
} from '@/app/(admin)/admin/lookup/phone-lookup'

/**
 * Caller lookup normaliser (VER-316). Teams fills `{phone}` with the caller's
 * E.164 number in a query string, so an unencoded `+` reaches the page decoded
 * as a space. Every caller form must resolve to the stored contact form(s):
 * mobiles are stored E.164, landlines formatting-stripped as entered.
 */
describe('phoneLookupCandidates', () => {
  describe('mobile callers match the stored E.164 form', () => {
    it.each([
      ['+61412345678', 'E.164 (encoded +)'],
      [' 61412345678', 'decoded + (Teams sends an unencoded +)'],
      ['0412345678', 'local'],
      ['61412345678', 'country code without +'],
      ['0412 345 678', 'formatted local'],
    ])('%s (%s) → +61412345678', (raw) => {
      expect(phoneLookupCandidates(raw)).toEqual(['+61412345678'])
    })
  })

  describe('landline callers match both stored landline forms', () => {
    it.each([
      ['+61862564449', 'E.164'],
      [' 61862564449', 'decoded +'],
      ['0862564449', 'local'],
      ['(08) 6256 4449', 'formatted local'],
    ])('%s (%s) → +61862564449 and 0862564449', (raw) => {
      expect(phoneLookupCandidates(raw)).toEqual(['+61862564449', '0862564449'])
    })
  })

  it('keeps an international caller in E.164, restoring a decoded +', () => {
    expect(phoneLookupCandidates('+447700900123')).toEqual(['+447700900123'])
    expect(phoneLookupCandidates(' 447700900123')).toEqual(['+447700900123'])
  })

  it('does not treat a leading space before a local 0 number as a +', () => {
    expect(phoneLookupCandidates(' 0412345678')).toEqual(['+61412345678'])
  })

  it.each([[''], ['   '], ['abc'], ['12'], ['{phone}']])(
    'returns no candidates for a non-number (%j)',
    (raw) => {
      expect(phoneLookupCandidates(raw)).toEqual([])
    },
  )
})

describe('formatPhoneDisplay', () => {
  it('formats a mobile as 04XX XXX XXX', () => {
    expect(formatPhoneDisplay('+61412345678')).toBe('0412 345 678')
  })

  it('formats a landline as 0X XXXX XXXX from either stored form', () => {
    expect(formatPhoneDisplay('+61862564449')).toBe('08 6256 4449')
    expect(formatPhoneDisplay('0862564449')).toBe('08 6256 4449')
  })

  it('shows anything else as stored', () => {
    expect(formatPhoneDisplay('1300123456')).toBe('1300123456')
    expect(formatPhoneDisplay('+447700900123')).toBe('+447700900123')
  })
})
