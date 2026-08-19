import { describe, it, expect } from 'vitest'
import {
  parseEfResponse,
  estimateCostUsd,
  formatEta,
  decideNext,
} from '../lib/geocode-loop'

describe('parseEfResponse', () => {
  it('accepts a well-formed live response', () => {
    const r = parseEfResponse({
      message: 'Geocoding complete. 498 succeeded (written), 2 failed.',
      total: 500,
      processed: 498,
      failed: 2,
      dry_run: false,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.total).toBe(500)
      expect(r.data.processed).toBe(498)
      expect(r.data.failed).toBe(2)
      expect(r.data.dry_run).toBe(false)
    }
  })

  it('preserves the errors array when present', () => {
    const r = parseEfResponse({
      message: '',
      total: 10,
      processed: 9,
      failed: 1,
      dry_run: false,
      errors: [{ id: 'abc', error: 'Geocode: ZERO_RESULTS' }],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.errors).toEqual([{ id: 'abc', error: 'Geocode: ZERO_RESULTS' }])
    }
  })

  it('returns ok=false on an EF-side error envelope', () => {
    const r = parseEfResponse({ error: 'Google Places API key not configured' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/API key/)
  })

  it('returns ok=false on a malformed body (missing counters)', () => {
    const r = parseEfResponse({ message: 'hi' })
    expect(r.ok).toBe(false)
  })

  it('returns ok=false on a non-object body', () => {
    expect(parseEfResponse(null).ok).toBe(false)
    expect(parseEfResponse('oops').ok).toBe(false)
  })

  it('returns ok=true when total/processed/failed are 0 (end-of-loop signal)', () => {
    const r = parseEfResponse({
      message: 'No properties missing google_place_id',
      processed: 0,
      total: 0,
      failed: 0,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.total).toBe(0)
  })

  // Regression — geocode-loop runner aborted on clean completion (2026-05-12)
  // because the EF's no-rows envelope omitted `failed`. Treat that shape as
  // a valid end-of-loop signal so the loop ends with exit 0, not an abort.
  it('returns ok=true on the legacy no-rows envelope without `failed`', () => {
    const r = parseEfResponse({
      message: 'No properties missing google_place_id',
      processed: 0,
      total: 0,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.total).toBe(0)
      expect(r.data.failed).toBe(0)
    }
  })

  it("still rejects mid-loop envelopes missing `failed` (where it'd actually matter)", () => {
    // If total=500 but failed is missing, that's a real EF bug, not the
    // benign end-of-loop case. Keep the strict check there.
    const r = parseEfResponse({ total: 500, processed: 498 })
    expect(r.ok).toBe(false)
  })
})

describe('estimateCostUsd', () => {
  it('charges $5 per 1000 rows once free quota is exhausted', () => {
    expect(estimateCostUsd(1000, 0)).toBe(5)
    expect(estimateCostUsd(500, 0)).toBe(2.5)
  })

  it('nets off remaining free-tier quota', () => {
    // 81,025 remaining VV rows, 2,000 free left this month
    // billable = 79,025 → 79.025 × $5 = $395.13
    expect(estimateCostUsd(81_025, 2_000)).toBe(395.13)
  })

  it('returns 0 when remaining rows fit entirely in the free tier', () => {
    expect(estimateCostUsd(500, 10_000)).toBe(0)
  })

  it('clamps negative free quota to 0 (caller error tolerance)', () => {
    expect(estimateCostUsd(1000, -500)).toBe(5)
  })
})

describe('formatEta', () => {
  it('renders minutes and seconds for multi-minute estimates', () => {
    // 60,000 rows / 23.2 rows/sec = ~2586s = 43m 6s
    expect(formatEta(60_000, 23.2)).toMatch(/^4[2-3]m \d+s$/)
  })

  it('renders seconds-only under one minute', () => {
    expect(formatEta(20, 1)).toBe('20s')
  })

  it("returns '—' on an unusable rate", () => {
    expect(formatEta(1000, 0)).toBe('—')
    expect(formatEta(1000, Number.NaN)).toBe('—')
  })
})

describe('decideNext', () => {
  it("returns 'done' when total === 0 (EF found no rows)", () => {
    const parsed = parseEfResponse({ total: 0, processed: 0, failed: 0 })
    expect(decideNext(parsed, 0, 3)).toEqual({ kind: 'done', reason: 'no-rows' })
  })

  it("returns 'continue' with counts on a healthy chunk", () => {
    const parsed = parseEfResponse({ total: 500, processed: 498, failed: 2 })
    expect(decideNext(parsed, 0, 3)).toEqual({
      kind: 'continue',
      processed: 498,
      failed: 2,
      total: 500,
    })
  })

  it("returns 'continue' on a single failure under the threshold", () => {
    const parsed = parseEfResponse({ error: 'transient' })
    const d = decideNext(parsed, 0, 3)
    expect(d.kind).toBe('continue')
  })

  it("returns 'abort' on the threshold-th consecutive failure", () => {
    const parsed = parseEfResponse({ error: 'still down' })
    const d = decideNext(parsed, 2, 3) // this would be failure #3
    expect(d.kind).toBe('abort')
    if (d.kind === 'abort') expect(d.reason).toMatch(/3 consecutive failures/)
  })

  // Snapped rows (street-number mismatch, e.g. a subdivided lot Google hasn't
  // ingested) keep google_place_id NULL by design, so they stay at the head of
  // the EF's queue. A chunk that is 100% snapped means the next chunk would
  // re-fetch the exact same rows — loop forever, re-billing Google each pass.
  it("returns 'done' when every row in the chunk was snapped", () => {
    const parsed = parseEfResponse({ total: 2, processed: 2, failed: 0, snapped: 2 })
    expect(decideNext(parsed, 0, 3)).toEqual({ kind: 'done', reason: 'all-snapped' })
  })

  it("returns 'continue' on a mixed snapped/geocoded chunk (still progressing)", () => {
    const parsed = parseEfResponse({ total: 10, processed: 10, failed: 0, snapped: 3 })
    const d = decideNext(parsed, 0, 3)
    expect(d.kind).toBe('continue')
  })
})
