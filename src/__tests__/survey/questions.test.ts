import { describe, it, expect } from 'vitest'
import {
  SURVEY_QUESTIONS,
  SURVEY_RATING_IDS,
  surveySections,
  validateResponses,
} from '@/lib/survey/questions'

/** A complete, valid response set for the fixed core question set. */
function validResponses() {
  return {
    attempted_repair: 'No',
    attempted_sell: 'Not applicable',
    booking_rating: 4,
    booking_comments: 'Easy to book.',
    collection_rating: 5,
    collection_comments: '',
    overall_rating: 5,
    prefer_service: 'Yes',
    other_comments: '',
  }
}

describe('SURVEY_QUESTIONS integrity', () => {
  it('has unique ids', () => {
    const ids = SURVEY_QUESTIONS.map((q) => q.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('rating ids match the reporting keys resident-satisfaction.ts reads (drift guard)', () => {
    // resident-satisfaction.ts hard-codes these keys; keep them in lockstep.
    expect([...SURVEY_RATING_IDS].sort()).toEqual([
      'booking_rating',
      'collection_rating',
      'overall_rating',
    ])
  })

  it('prefer_service is a radio with exactly Yes/No/Indifferent', () => {
    const q = SURVEY_QUESTIONS.find((x) => x.id === 'prefer_service')
    expect(q?.type).toBe('radio')
    expect(q?.options).toEqual(['Yes', 'No', 'Indifferent'])
  })

  it('select/radio questions carry options; others do not', () => {
    for (const q of SURVEY_QUESTIONS) {
      if (q.type === 'select' || q.type === 'radio') {
        expect(q.options && q.options.length).toBeGreaterThan(0)
      } else {
        expect(q.options).toBeUndefined()
      }
    }
  })
})

describe('surveySections', () => {
  it('groups into the four form sections in order', () => {
    expect(surveySections().map((s) => s.section)).toEqual([
      'About Your Collection',
      'Booking Feedback',
      'Collection Feedback',
      'Overall Feedback',
    ])
  })
})

describe('validateResponses', () => {
  it('accepts a complete valid set and coerces ratings to numbers', () => {
    const r = validateResponses(validResponses())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.booking_rating).toBe(4)
      expect(typeof r.data.overall_rating).toBe('number')
      expect(r.data.prefer_service).toBe('Yes')
      // empty optional strings are dropped, not stored
      expect('collection_comments' in r.data).toBe(false)
    }
  })

  it('rejects a non-object', () => {
    expect(validateResponses(null).ok).toBe(false)
    expect(validateResponses([]).ok).toBe(false)
    expect(validateResponses('x').ok).toBe(false)
  })

  it('rejects an unknown key', () => {
    const r = validateResponses({ ...validResponses(), sneaky: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('sneaky')
  })

  it('rejects a missing required answer', () => {
    const { overall_rating: _omit, ...rest } = validResponses()
    void _omit
    const r = validateResponses(rest)
    expect(r.ok).toBe(false)
  })

  it('allows optional answers to be omitted', () => {
    const base = validResponses()
    delete (base as Record<string, unknown>).booking_comments
    delete (base as Record<string, unknown>).other_comments
    expect(validateResponses(base).ok).toBe(true)
  })

  it.each([0, 6, 3.5, '3', 'x'])('rejects invalid rating %s', (bad) => {
    const r = validateResponses({ ...validResponses(), overall_rating: bad })
    // '3' is a numeric string → valid; everything else invalid
    if (bad === '3') expect(r.ok).toBe(true)
    else expect(r.ok).toBe(false)
  })

  it('accepts a numeric-string rating and coerces it', () => {
    const r = validateResponses({ ...validResponses(), booking_rating: '5' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.booking_rating).toBe(5)
  })

  it('rejects a choice value not in the option list', () => {
    const r = validateResponses({ ...validResponses(), prefer_service: 'Maybe' })
    expect(r.ok).toBe(false)
  })

  it('rejects over-long text', () => {
    const r = validateResponses({ ...validResponses(), booking_comments: 'a'.repeat(2001) })
    expect(r.ok).toBe(false)
  })
})
