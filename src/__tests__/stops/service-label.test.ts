import { describe, expect, it } from 'vitest'
import type { Json } from '@/lib/supabase/types'
import {
  STOP_CLOSEOUT_SELECT,
  distinctServiceNames,
  pendingServicesLabel,
  serviceLabelFromSummary,
} from '@/lib/stops/service-label'

describe('serviceLabelFromSummary', () => {
  it('joins distinct service names in summary order', () => {
    const summary: Json = [
      { name: 'E-Waste', qty: 1 },
      { name: 'Mattress', qty: 2 },
    ]
    expect(serviceLabelFromSummary(summary, 'ancillary')).toEqual({
      label: 'E-Waste, Mattress',
      fromFallback: false,
    })
  })

  it('handles a single-service general stop', () => {
    const summary: Json = [{ name: 'Bulk Waste', qty: 1 }]
    expect(serviceLabelFromSummary(summary, 'general')).toEqual({
      label: 'Bulk Waste',
      fromFallback: false,
    })
  })

  it('falls back to service-vocabulary label on empty array (never stream jargon)', () => {
    expect(serviceLabelFromSummary([], 'ancillary')).toEqual({
      label: 'Ancillary items',
      fromFallback: true,
    })
    expect(serviceLabelFromSummary([], 'general')).toEqual({
      label: 'Bulk Waste',
      fromFallback: true,
    })
    expect(serviceLabelFromSummary([], 'green')).toEqual({
      label: 'Green Waste',
      fromFallback: true,
    })
  })

  it('falls back on null / undefined summary', () => {
    expect(serviceLabelFromSummary(null, 'green').fromFallback).toBe(true)
    expect(serviceLabelFromSummary(undefined, 'green').fromFallback).toBe(true)
  })

  it('falls back on a non-array summary (malformed jsonb)', () => {
    expect(serviceLabelFromSummary('E-Waste' as unknown as Json, 'ancillary').fromFallback).toBe(true)
    expect(serviceLabelFromSummary({ name: 'x' } as unknown as Json, 'ancillary').fromFallback).toBe(true)
  })

  it('does not crash or render "undefined" for malformed elements ([null], [{}], missing name)', () => {
    // [null] would throw on s.name; [{}] / [{nam:..}] would map to undefined → "undefined".
    expect(serviceLabelFromSummary([null] as unknown as Json, 'ancillary')).toEqual({
      label: 'Ancillary items',
      fromFallback: true,
    })
    expect(serviceLabelFromSummary([{}] as unknown as Json, 'ancillary')).toEqual({
      label: 'Ancillary items',
      fromFallback: true,
    })
    expect(serviceLabelFromSummary([{ nam: 'Mattress' }] as unknown as Json, 'ancillary').fromFallback).toBe(true)
    expect(serviceLabelFromSummary([{ name: '   ' }] as unknown as Json, 'ancillary').fromFallback).toBe(true)
  })

  it('keeps valid entries and drops malformed siblings', () => {
    const summary = [{ name: 'Mattress', qty: 1 }, null, { name: '' }] as unknown as Json
    expect(serviceLabelFromSummary(summary, 'ancillary')).toEqual({
      label: 'Mattress',
      fromFallback: false,
    })
  })
})

describe('distinctServiceNames', () => {
  it('dedupes and sorts service names', () => {
    const items = [
      { service: { name: 'Green Waste' } },
      { service: { name: 'Bulk Waste' } },
      { service: { name: 'Green Waste' } },
    ]
    expect(distinctServiceNames(items)).toBe('Bulk Waste, Green Waste')
  })

  it('returns undefined for no items (row omitted)', () => {
    expect(distinctServiceNames([])).toBeUndefined()
    expect(distinctServiceNames(null)).toBeUndefined()
    expect(distinctServiceNames(undefined)).toBeUndefined()
  })
})

describe('pendingServicesLabel', () => {
  it('labels a pending sibling from its services_summary', () => {
    const siblings = [
      { stream: 'green' as const, services_summary: [{ name: 'Green Waste', qty: 1 }] as Json },
    ]
    expect(pendingServicesLabel(siblings)).toBe('Green Waste')
  })

  it('joins distinct labels across multiple pending siblings, sorted', () => {
    const siblings = [
      { stream: 'green' as const, services_summary: [{ name: 'Green Waste', qty: 1 }] as Json },
      {
        stream: 'ancillary' as const,
        services_summary: [{ name: 'Mattress', qty: 2 }] as Json,
      },
    ]
    expect(pendingServicesLabel(siblings)).toBe('Green Waste, Mattress')
  })

  it('falls back to stream vocabulary for a sibling with an empty summary', () => {
    const siblings = [{ stream: 'ancillary' as const, services_summary: [] as Json }]
    expect(pendingServicesLabel(siblings)).toBe('Ancillary items')
  })

  it('returns undefined when nothing is pending (line omitted)', () => {
    expect(pendingServicesLabel([])).toBeUndefined()
  })
})

describe('STOP_CLOSEOUT_SELECT', () => {
  it('selects services_summary so the label never silently reverts to the fallback', () => {
    expect(STOP_CLOSEOUT_SELECT).toContain('services_summary')
    expect(STOP_CLOSEOUT_SELECT).toContain('stream')
    expect(STOP_CLOSEOUT_SELECT).toContain('booking:booking_id')
  })
})
