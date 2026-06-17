import { describe, it, expect } from 'vitest'
import {
  computeVolumeMix,
  VOLUME_MIX_LOW_N,
  type VolumeMixRow,
} from '@/lib/reports/volume-mix'

/**
 * Helper to build a row with sensible defaults — keeps the cases focused on the
 * field under test (waste_stream / is_extra / the actual_services fallback).
 */
function row(overrides: Partial<VolumeMixRow> = {}): VolumeMixRow {
  return {
    no_services: 1,
    actual_services: null,
    is_extra: false,
    waste_stream: 'general',
    service_name: 'General Waste',
    ...overrides,
  }
}

describe('computeVolumeMix', () => {
  describe('exported constant', () => {
    it('VOLUME_MIX_LOW_N is 20 (spec §3.8)', () => {
      expect(VOLUME_MIX_LOW_N).toBe(20)
    })
  })

  describe('empty', () => {
    it('no rows → isEmpty, zero totals, empty breakdowns', () => {
      const result = computeVolumeMix([])
      expect(result.totalCollections).toBe(0)
      expect(result.isEmpty).toBe(true)
      expect(result.isLowN).toBe(false)
      expect(result.byStream).toEqual({})
      expect(result.byService).toEqual([])
      expect(result.freeUnits).toBe(0)
      expect(result.extraUnits).toBe(0)
    })

    it('rows that sum to zero volume → isEmpty', () => {
      const result = computeVolumeMix([
        row({ no_services: 0, actual_services: 0 }),
      ])
      expect(result.totalCollections).toBe(0)
      expect(result.isEmpty).toBe(true)
      expect(result.isLowN).toBe(false)
    })
  })

  describe('volume_unit fallback (actual_services ?? no_services)', () => {
    it('uses no_services when actual_services is null', () => {
      const result = computeVolumeMix([
        row({ no_services: 3, actual_services: null }),
      ])
      expect(result.totalCollections).toBe(3)
      expect(result.byStream.general).toBe(3)
    })

    it('uses actual_services when present (overrides no_services)', () => {
      const result = computeVolumeMix([
        row({ no_services: 3, actual_services: 5 }),
      ])
      expect(result.totalCollections).toBe(5)
      expect(result.byStream.general).toBe(5)
    })

    it('uses actual_services even when it is 0 (?? not ||)', () => {
      const result = computeVolumeMix([
        row({ no_services: 4, actual_services: 0, is_extra: false }),
      ])
      // actual_services=0 wins over no_services=4 — a confirmed zero collection
      expect(result.totalCollections).toBe(0)
      expect(result.isEmpty).toBe(true)
    })
  })

  describe('single stream', () => {
    it('aggregates one stream', () => {
      const result = computeVolumeMix([
        row({ no_services: 2, waste_stream: 'general' }),
        row({ no_services: 1, waste_stream: 'general' }),
      ])
      expect(result.totalCollections).toBe(3)
      expect(result.byStream).toEqual({ general: 3 })
    })
  })

  describe('multi stream', () => {
    it('splits totals across streams and keys byStream by WasteStream', () => {
      const result = computeVolumeMix([
        row({ no_services: 5, waste_stream: 'general', service_name: 'General' }),
        row({ no_services: 3, waste_stream: 'green', service_name: 'Green' }),
        row({ no_services: 2, waste_stream: 'ancillary', service_name: 'Mattress' }),
        row({ no_services: 1, waste_stream: 'illegal_dumping', service_name: 'ID' }),
      ])
      expect(result.totalCollections).toBe(11)
      expect(result.byStream).toEqual({
        general: 5,
        green: 3,
        ancillary: 2,
        illegal_dumping: 1,
      })
    })

    it('only includes streams that appear (no zero-filled keys)', () => {
      const result = computeVolumeMix([row({ no_services: 4, waste_stream: 'green' })])
      expect(result.byStream).toEqual({ green: 4 })
      expect(Object.keys(result.byStream)).not.toContain('general')
    })
  })

  describe('byService', () => {
    it('groups by service name and sorts qty descending', () => {
      const result = computeVolumeMix([
        row({ no_services: 1, service_name: 'Mattress', waste_stream: 'ancillary' }),
        row({ no_services: 6, service_name: 'General', waste_stream: 'general' }),
        row({ no_services: 3, service_name: 'Green', waste_stream: 'green' }),
      ])
      expect(result.byService).toEqual([
        { name: 'General', qty: 6 },
        { name: 'Green', qty: 3 },
        { name: 'Mattress', qty: 1 },
      ])
    })

    it('combines rows with the same service name', () => {
      const result = computeVolumeMix([
        row({ no_services: 2, service_name: 'General', waste_stream: 'general' }),
        row({ no_services: 3, service_name: 'General', waste_stream: 'general' }),
      ])
      expect(result.byService).toEqual([{ name: 'General', qty: 5 }])
    })
  })

  describe('free vs extra split', () => {
    it('partitions volume into freeUnits / extraUnits by is_extra', () => {
      const result = computeVolumeMix([
        row({ no_services: 4, is_extra: false }),
        row({ no_services: 2, is_extra: true }),
        row({ no_services: 1, is_extra: true }),
      ])
      expect(result.freeUnits).toBe(4)
      expect(result.extraUnits).toBe(3)
      // total is independent of the free/extra split
      expect(result.totalCollections).toBe(7)
    })

    it('extra split uses the actual_services fallback too', () => {
      const result = computeVolumeMix([
        row({ no_services: 1, actual_services: 5, is_extra: true }),
      ])
      expect(result.extraUnits).toBe(5)
      expect(result.freeUnits).toBe(0)
    })
  })

  describe('low-n boundary (LOW_N = 20)', () => {
    it('total of 1 → isLowN', () => {
      const result = computeVolumeMix([row({ no_services: 1 })])
      expect(result.isEmpty).toBe(false)
      expect(result.isLowN).toBe(true)
    })

    it('total of 19 → isLowN (just below threshold)', () => {
      const result = computeVolumeMix([row({ no_services: 19 })])
      expect(result.totalCollections).toBe(19)
      expect(result.isLowN).toBe(true)
    })

    it('total of exactly 20 → at-n (not low-n)', () => {
      const result = computeVolumeMix([row({ no_services: 20 })])
      expect(result.totalCollections).toBe(20)
      expect(result.isLowN).toBe(false)
      expect(result.isEmpty).toBe(false)
    })

    it('total of 21 → at-n', () => {
      const result = computeVolumeMix([row({ no_services: 21 })])
      expect(result.isLowN).toBe(false)
      expect(result.isEmpty).toBe(false)
    })
  })

  describe('invalid / defensive inputs', () => {
    it('treats null/undefined no_services as 0', () => {
      const result = computeVolumeMix([
        row({ no_services: null as unknown as number, actual_services: null }),
      ])
      expect(result.totalCollections).toBe(0)
      expect(result.isEmpty).toBe(true)
    })

    it('treats NaN volume as 0 (never propagates NaN into totals)', () => {
      const result = computeVolumeMix([
        row({ no_services: Number.NaN, actual_services: null, waste_stream: 'general' }),
        row({ no_services: 5, waste_stream: 'green' }),
      ])
      expect(result.totalCollections).toBe(5)
      expect(Number.isNaN(result.totalCollections)).toBe(false)
      expect(result.byStream.green).toBe(5)
      // the NaN row contributed nothing rather than a NaN bucket
      expect(result.byStream.general ?? 0).toBe(0)
    })

    it('clamps negative volume to 0', () => {
      const result = computeVolumeMix([
        row({ no_services: -3, actual_services: null }),
        row({ no_services: 4 }),
      ])
      expect(result.totalCollections).toBe(4)
    })

    it('handles a row with a missing/empty service_name without crashing', () => {
      const result = computeVolumeMix([
        row({ no_services: 2, service_name: '' as unknown as string }),
      ])
      expect(result.totalCollections).toBe(2)
      // an empty-named service still aggregates under its (empty) key
      expect(result.byService.reduce((s, x) => s + x.qty, 0)).toBe(2)
    })
  })

  describe('determinism', () => {
    it('produces identical output for the same input regardless of call order', () => {
      const rows = [
        row({ no_services: 3, service_name: 'Green', waste_stream: 'green' }),
        row({ no_services: 7, service_name: 'General', waste_stream: 'general', is_extra: true }),
      ]
      expect(computeVolumeMix(rows)).toEqual(computeVolumeMix(rows))
    })
  })
})
