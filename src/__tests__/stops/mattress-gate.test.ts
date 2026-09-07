import { describe, expect, it } from 'vitest'
import {
  isMissingRequiredCount,
  MATTRESS_COUNT_MAX,
  stopLogsMattresses,
  validateMattressCount,
} from '@/lib/stops/mattress'

describe('stopLogsMattresses', () => {
  it('requires the count only when the client stream matches the stop stream', () => {
    expect(stopLogsMattresses('general', 'general')).toBe(true)
    expect(stopLogsMattresses('general', 'green')).toBe(false)
  })

  it('NULL client stream means the tenant never logs at closeout (KWN)', () => {
    expect(stopLogsMattresses(null, 'general')).toBe(false)
    expect(stopLogsMattresses(undefined, 'general')).toBe(false)
  })
})

describe('validateMattressCount', () => {
  it('accepts 0 — "none collected" is a real answer, never a gap', () => {
    expect(validateMattressCount(true, 0)).toEqual({ ok: true, data: 0 })
  })

  it('accepts a positive integer', () => {
    expect(validateMattressCount(true, 4)).toEqual({ ok: true, data: 4 })
  })

  it('accepts a missing count as NULL ("uncounted") — a pre-counter client must still be able to close the stop (ADR 0011, 03/08 outage)', () => {
    expect(validateMattressCount(true, null)).toEqual({ ok: true, data: null })
    expect(validateMattressCount(true, undefined)).toEqual({ ok: true, data: null })
  })

  it('rejects negatives, floats and NaN', () => {
    expect(validateMattressCount(true, -1).ok).toBe(false)
    expect(validateMattressCount(true, 1.5).ok).toBe(false)
    expect(validateMattressCount(true, Number.NaN).ok).toBe(false)
  })

  it('rejects an implausibly large count', () => {
    expect(validateMattressCount(true, MATTRESS_COUNT_MAX + 1).ok).toBe(false)
    expect(validateMattressCount(true, MATTRESS_COUNT_MAX)).toEqual({
      ok: true,
      data: MATTRESS_COUNT_MAX,
    })
  })

  it('when not required, DISCARDS any submitted count — non-logging tenants must stay NULL', () => {
    expect(validateMattressCount(false, 7)).toEqual({ ok: true, data: null })
    expect(validateMattressCount(false, null)).toEqual({ ok: true, data: null })
  })
})

describe('isMissingRequiredCount', () => {
  it('flags a logging stop closing with no count — the stale-client signal the action reports to Sentry', () => {
    expect(isMissingRequiredCount(true, null)).toBe(true)
    expect(isMissingRequiredCount(true, undefined)).toBe(true)
  })

  it('quiet when a count was sent, or when the stop never logs', () => {
    expect(isMissingRequiredCount(true, 0)).toBe(false)
    expect(isMissingRequiredCount(true, 3)).toBe(false)
    expect(isMissingRequiredCount(false, null)).toBe(false)
    expect(isMissingRequiredCount(false, 5)).toBe(false)
  })
})
