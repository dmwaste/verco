import { describe, expect, it } from 'vitest'
import {
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

  it('rejects a missing count when required — the gate is the point', () => {
    expect(validateMattressCount(true, null).ok).toBe(false)
    expect(validateMattressCount(true, undefined).ok).toBe(false)
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
