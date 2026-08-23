import { describe, it, expect } from 'vitest'
import { dedupeByExternalRef, mapAttemptedSell, parseAirtableDateTime, parseRating, parseSurveyRow } from '../import-vv-surveys-csv'

describe('parseAirtableDateTime', () => {
  it('reads m/d/yyyy h:mmam as Perth local and returns UTC', () => {
    expect(parseAirtableDateTime('8/22/2026 8:33pm')).toBe('2026-08-22T12:33:00.000Z')
    expect(parseAirtableDateTime('1/10/2026 12:05am')).toBe('2026-01-09T16:05:00.000Z')
    expect(parseAirtableDateTime('9/8/2025 12:06pm')).toBe('2025-09-08T04:06:00.000Z')
    expect(parseAirtableDateTime('')).toBeNull()
  })
})

describe('parseRating', () => {
  it('coerces Airtable decimals to 1..5 integers', () => {
    expect(parseRating('5.00')).toBe(5)
    expect(parseRating('1.00')).toBe(1)
    expect(parseRating('4.5')).toBeNull()
    expect(parseRating('0')).toBeNull()
    expect(parseRating('')).toBeNull()
  })
})

describe('mapAttemptedSell', () => {
  it('maps the multi-select onto the single-choice sell question', () => {
    expect(mapAttemptedSell('Charity/Shops/Collections,Friends/Family/Neighbours,Facebook Marketplace')).toBe('Yes — sold online (e.g. Facebook Marketplace)')
    expect(mapAttemptedSell('Charity/Shops/Collections,Friends/Family/Neighbours')).toBe('Yes — gave to family/friends')
    expect(mapAttemptedSell('Charity/Shops/Collections')).toBeNull()
    expect(mapAttemptedSell('')).toBeNull()
  })
})

describe('parseSurveyRow', () => {
  const row = {
    Booking_Ref: 'VIN-B-58104', Council: 'VIN', 'Create Date': '8/22/2026 8:33pm',
    'Booking Rating': '5.00', 'Collection Rating': '4.00', 'Overall Rating': '5.00',
    'Booking Comments': 'easy', 'Collection Comments': '', 'Other Comments': 'ta',
    'Prefer VV': 'Indifferent', 'Attempt to Repair': 'Yes', 'Attempt to Move': 'Gumtree / Ebay',
    'Services Used': 'Bulk Waste,Mattress', 'Sentiment AI': 'Positive', 'Ranking Sentiment': 'Positive',
    'Contact Email': 'x@y.z', 'Contact Name': 'X Y',
  }
  it('builds the shipped question keys plus flat legacy keys, never PII', () => {
    const p = parseSurveyRow(row)
    expect(p.responses).toEqual({
      booking_rating: 5, collection_rating: 4, overall_rating: 5,
      booking_comments: 'easy', other_comments: 'ta',
      prefer_service: 'Indifferent', attempted_repair: 'Yes — attempted repair',
      attempted_sell: 'Yes — sold online (e.g. Facebook Marketplace)',
      legacy_services_used: 'Bulk Waste,Mattress', legacy_attempt_to_move: 'Gumtree / Ebay',
      legacy_attempt_to_repair: 'Yes', legacy_sentiment_ai: 'Positive', legacy_ranking_sentiment: 'Positive',
    })
    expect(JSON.stringify(p.responses)).not.toMatch(/x@y\.z|X Y/)
    expect(p.externalRef).toBe('VIN-B-58104|8/22/2026 8:33pm')
    expect(p.submittedAt).toBe('2026-08-22T12:33:00.000Z')
    expect(p.hasRating).toBe(true)
  })
  it('flags rows with no valid rating and keeps a stable ref without a booking', () => {
    const p = parseSurveyRow({ ...row, Booking_Ref: '', 'Booking Rating': '', 'Collection Rating': '', 'Overall Rating': '' })
    expect(p.hasRating).toBe(false)
    expect(p.externalRef).toBe('|8/22/2026 8:33pm')
  })
})

describe('dedupeByExternalRef', () => {
  it('keeps the first of an Airtable double-submit (same ref + minute)', () => {
    const a = { externalRef: 'COT-54300|6/7/2026 3:41pm', n: 1 }
    const b = { externalRef: 'COT-54300|6/7/2026 3:41pm', n: 2 }
    const c = { externalRef: 'COT-54301|6/7/2026 3:41pm', n: 3 }
    expect(dedupeByExternalRef([a, b, c]).map((x) => x.n)).toEqual([1, 3])
  })
})
