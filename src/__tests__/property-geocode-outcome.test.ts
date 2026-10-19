import { describe, expect, it, vi } from 'vitest'
import {
  propertyGeocodeOutcome,
  rejectionExplanation,
  runGeocodeQueue,
  type GeocodeEfResponse,
} from '@/lib/properties/geocode-outcome'
import type { Result } from '@/lib/result'

const ok = (data: GeocodeEfResponse): Result<GeocodeEfResponse> => ({ ok: true, data })

describe('propertyGeocodeOutcome — one property geocoded by id', () => {
  it('pinned when the EF wrote the row', () => {
    expect(propertyGeocodeOutcome('p1', ok({ total: 1, processed: 1, failed: 0 }))).toEqual({ kind: 'pinned' })
  })

  // 13 cronin way anketel (KWN-4-1MGKF0, 15/10/2026): Google's answer was refused
  // and nothing was written. The admin must be told, with what Google matched.
  it('rejected carries what Google matched and why', () => {
    const res = ok({
      total: 1,
      processed: 0,
      failed: 0,
      rejected: 1,
      rejected_samples: [{ id: 'p1', address: '4 Faba Place, Wellard WA 6170, Australia', google: 'Wellard WA 6170, Australia', reason: 'granularity' }],
    })
    expect(propertyGeocodeOutcome('p1', res)).toEqual({
      kind: 'rejected',
      google: 'Wellard WA 6170, Australia',
      reason: 'granularity',
    })
  })

  // The EF answers HTTP 500 when any row failed, so the summary arrives as the
  // error body. Read it rather than show raw JSON.
  it('failed reads the per-row error out of the EF 500 body', () => {
    const body = JSON.stringify({ total: 1, processed: 0, failed: 1, errors: [{ id: 'p1', error: 'Geocode: ZERO_RESULTS' }] })
    expect(propertyGeocodeOutcome('p1', { ok: false, error: body })).toEqual({
      kind: 'failed',
      error: 'Geocode: ZERO_RESULTS',
    })
  })

  it('failed passes an EF error message through', () => {
    expect(propertyGeocodeOutcome('p1', { ok: false, error: '{"error":"Forbidden: staff role required"}' })).toEqual({
      kind: 'failed',
      error: 'Forbidden: staff role required',
    })
    expect(propertyGeocodeOutcome('p1', { ok: false, error: 'No active session. Please sign in and try again.' })).toEqual({
      kind: 'failed',
      error: 'No active session. Please sign in and try again.',
    })
  })

  it('failed when the EF never saw the row (nothing to geocode)', () => {
    expect(propertyGeocodeOutcome('p1', ok({ total: 0, processed: 0, failed: 0 })).kind).toBe('failed')
  })
})

describe('rejectionExplanation', () => {
  it('different suburb: names the match and asks for the postcode', () => {
    const text = rejectionExplanation('7 Vincent St, Mount Lawley WA 6050, Australia', 'locality')
    expect(text).toContain('7 Vincent St, Mount Lawley WA 6050, Australia')
    expect(text).toMatch(/different suburb/)
    expect(text).toMatch(/postcode/)
  })

  // Faba Place / Ejarup Cl already carry suburb + postcode; "add the postcode"
  // is the wrong advice when Google simply doesn't know the street.
  it('suburb-only match: says Google could not find the street, not "add the postcode"', () => {
    const text = rejectionExplanation('Wellard WA 6170, Australia', 'granularity')
    expect(text).toMatch(/could only find/)
    expect(text).toMatch(/street/)
    expect(text).not.toMatch(/postcode/)
  })

  it('interstate', () => {
    expect(rejectionExplanation('10 Market St, Kensington VIC 3031, Australia', 'state')).toMatch(/interstate/)
  })
})

describe('runGeocodeQueue — the Geocode All / import loop', () => {
  // Regression (15/10/2026): 26 "snapped" rows keep google_place_id NULL by
  // design (#508), so every call re-geocoded them and reported processed=26.
  // The loop's only stop was processed===0, so it ran its 100-call backstop
  // (~3,100 Google lookups per click) and reported rejected=0, hiding the
  // property that really had no pin.
  it('stops after one call when that call covered the whole queue', async () => {
    const invoke = vi.fn().mockResolvedValue(
      ok({ total: 31, processed: 26, snapped: 26, failed: 0, rejected: 5 }),
    )
    const res = await runGeocodeQueue(invoke)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith({ limit: 500 })
    expect(res).toEqual({ ok: true, data: { geocoded: 0, rejected: 5, failed: 0 } })
  })

  it('keeps going while full chunks move rows out of the queue, then reports what is left', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(ok({ total: 500, processed: 500, snapped: 0, failed: 0, rejected: 0 }))
      .mockResolvedValueOnce(ok({ total: 120, processed: 100, snapped: 3, failed: 0, rejected: 20 }))
    const res = await runGeocodeQueue(invoke)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(res).toEqual({ ok: true, data: { geocoded: 597, rejected: 20, failed: 0 } })
  })

  it('stops when a full chunk moved nothing out of the queue (only stuck rows left)', async () => {
    const invoke = vi.fn().mockResolvedValue(
      ok({ total: 500, processed: 480, snapped: 480, failed: 0, rejected: 20 }),
    )
    const res = await runGeocodeQueue(invoke)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ ok: true, data: { geocoded: 0, rejected: 20, failed: 0 } })
  })

  it('reads failed rows out of the EF 500 body instead of failing the whole run', async () => {
    const body = JSON.stringify({ total: 3, processed: 2, failed: 1, errors: [{ id: 'x', error: 'Geocode: ZERO_RESULTS' }] })
    const invoke = vi.fn().mockResolvedValue({ ok: false, error: body })
    const res = await runGeocodeQueue(invoke)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ ok: true, data: { geocoded: 2, rejected: 0, failed: 1 } })
  })

  it('returns the error when the EF call itself fails', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: false, error: '{"error":"Forbidden: staff role required"}' })
    expect(await runGeocodeQueue(invoke)).toEqual({ ok: false, error: 'Forbidden: staff role required' })
  })

  it('still honours the iteration backstop', async () => {
    const invoke = vi.fn().mockResolvedValue(ok({ total: 500, processed: 500, snapped: 0, failed: 0, rejected: 0 }))
    await runGeocodeQueue(invoke, { maxIterations: 3 })
    expect(invoke).toHaveBeenCalledTimes(3)
  })
})
