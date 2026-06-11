import { describe, it, expect } from 'vitest'
import { formatServingLine, stripLgaPrefix } from '@/app/landing/serving-line'

describe('stripLgaPrefix', () => {
  it('strips City of / Town of / Shire of', () => {
    expect(stripLgaPrefix('City of Fremantle')).toBe('Fremantle')
    expect(stripLgaPrefix('Town of Cambridge')).toBe('Cambridge')
    expect(stripLgaPrefix('Shire of Peppermint Grove')).toBe('Peppermint Grove')
  })

  it('leaves a name without an LGA prefix untouched', () => {
    expect(stripLgaPrefix('Kwinana')).toBe('Kwinana')
  })
})

describe('formatServingLine', () => {
  it('returns null for no members (single-LGA client)', () => {
    expect(formatServingLine([])).toBeNull()
  })

  it('keeps the full LGA name for a single member', () => {
    expect(formatServingLine(['City of Vincent'])).toBe(
      'Serving City of Vincent.',
    )
  })

  it('joins two with an ampersand, full names, sorted by place', () => {
    expect(formatServingLine(['Town of Cambridge', 'City of Fremantle'])).toBe(
      'Serving Town of Cambridge & City of Fremantle.',
    )
  })

  it('comma-separates 3+ with an ampersand before the last, full names', () => {
    expect(
      formatServingLine([
        'City of Vincent',
        'City of Fremantle',
        'Town of Cottesloe',
      ]),
    ).toBe('Serving Town of Cottesloe, City of Fremantle & City of Vincent.')
  })

  it('sorts by the place name, not the LGA prefix', () => {
    // "Town of Albany" sorts before "City of Bunbury" by place name, even
    // though the displayed prefixes differ.
    expect(formatServingLine(['City of Bunbury', 'Town of Albany'])).toBe(
      'Serving Town of Albany & City of Bunbury.',
    )
  })

  it('matches the real Verge Valet roster', () => {
    expect(
      formatServingLine([
        'City of Fremantle',
        'City of South Perth',
        'City of Subiaco',
        'City of Vincent',
        'Shire of Peppermint Grove',
        'Town of Cambridge',
        'Town of Cottesloe',
        'Town of Mosman Park',
        'Town of Victoria Park',
      ]),
    ).toBe(
      'Serving Town of Cambridge, Town of Cottesloe, City of Fremantle, Town of Mosman Park, Shire of Peppermint Grove, City of South Perth, City of Subiaco, Town of Victoria Park & City of Vincent.',
    )
  })
})
