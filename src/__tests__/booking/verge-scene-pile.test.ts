import { describe, it, expect } from 'vitest'
import {
  buildPile,
  describePile,
  pickScenePile,
  pileHeight,
  visibleUnits,
  PILE_FOOTPRINT,
  PILE_MAX_UNITS,
  type WasteStream,
} from '@/components/booking/verge-scene/pile'

const STREAMS: WasteStream[] = ['general', 'green', 'ancillary', 'illegal_dumping']

describe('visibleUnits', () => {
  it('treats zero, negative and non-numbers as an empty verge', () => {
    expect(visibleUnits(0)).toBe(0)
    expect(visibleUnits(-3)).toBe(0)
    expect(visibleUnits(Number.NaN)).toBe(0)
    expect(visibleUnits(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('floors fractions and caps at PILE_MAX_UNITS', () => {
    expect(visibleUnits(2.9)).toBe(2)
    expect(visibleUnits(PILE_MAX_UNITS + 10)).toBe(PILE_MAX_UNITS)
  })
})

describe('buildPile', () => {
  it('draws nothing for an empty cart', () => {
    for (const stream of STREAMS) expect(buildPile(stream, 0)).toEqual([])
  })

  it('draws one item per ancillary unit — a unit is a single mattress or appliance', () => {
    expect(buildPile('ancillary', 3)).toHaveLength(3)
  })

  it('draws a loose load per unit for the other streams', () => {
    expect(buildPile('general', 2)).toHaveLength(6)
    expect(buildPile('green', 2)).toHaveLength(8)
    expect(buildPile('illegal_dumping', 2)).toHaveLength(6)
  })

  it('stops growing past PILE_MAX_UNITS', () => {
    expect(buildPile('general', 50)).toEqual(buildPile('general', PILE_MAX_UNITS))
  })

  it('is deterministic — same props, same pile', () => {
    expect(buildPile('green', 4)).toEqual(buildPile('green', 4))
  })

  // The canvas keys pieces by index: adding a unit must only append, or every
  // tap of + would reshuffle the whole pile.
  it.each(STREAMS)('%s: a bigger pile keeps the smaller pile as its first pieces', (stream) => {
    for (let units = 1; units < PILE_MAX_UNITS; units++) {
      const smaller = buildPile(stream, units)
      expect(buildPile(stream, units + 1).slice(0, smaller.length)).toEqual(smaller)
    }
  })

  it.each(STREAMS)('%s: every piece sits inside the verge footprint and on or above the ground', (stream) => {
    for (const piece of buildPile(stream, PILE_MAX_UNITS)) {
      const [x, y, z] = piece.position
      const [w, h, d] = piece.size
      expect(Math.abs(x)).toBeLessThanOrEqual(PILE_FOOTPRINT.x)
      expect(Math.abs(z)).toBeLessThanOrEqual(PILE_FOOTPRINT.z)
      expect(y - h / 2).toBeGreaterThanOrEqual(0)
      expect(w).toBeGreaterThan(0)
      expect(d).toBeGreaterThan(0)
    }
  })

  it('stacks pieces into a mound that rises as units are added', () => {
    const one = pileHeight(buildPile('general', 1))
    const six = pileHeight(buildPile('general', 6))
    expect(one).toBeGreaterThan(0)
    expect(six).toBeGreaterThan(one)
  })

  it('uses shapes that read as each stream', () => {
    const shapes = (stream: WasteStream) => new Set(buildPile(stream, PILE_MAX_UNITS).map((p) => p.shape))
    expect([...shapes('green')].every((s) => s === 'branch' || s === 'leaves')).toBe(true)
    expect([...shapes('ancillary')].every((s) => ['mattress', 'appliance', 'screen'].includes(s))).toBe(true)
    expect(shapes('illegal_dumping').has('tyre')).toBe(true)
    expect(shapes('general').has('branch')).toBe(false)
  })
})

describe('pileHeight', () => {
  it('is 0 for an empty pile', () => {
    expect(pileHeight([])).toBe(0)
  })
})

describe('describePile', () => {
  it('describes an empty verge', () => {
    expect(describePile('general', 0)).toBe('Illustration of a house with an empty verge.')
  })

  it('names the stream in plain words with the booked count', () => {
    expect(describePile('green', 3)).toBe('Illustration of a house with green waste on the verge, 3 booked.')
    expect(describePile('illegal_dumping', 1)).toContain('dumped rubbish')
  })

  it('reports the real count even past the drawing cap', () => {
    expect(describePile('general', 9)).toContain('9 booked')
  })
})

describe('pickScenePile', () => {
  it('shows an empty general verge for an empty cart', () => {
    expect(pickScenePile([])).toEqual({ stream: 'general', size: 0 })
    expect(pickScenePile([{ stream: 'green', quantity: 0 }])).toEqual({ stream: 'general', size: 0 })
  })

  it('picks the stream with the most units, summed across services', () => {
    expect(
      pickScenePile([
        { stream: 'general', quantity: 1 },
        { stream: 'ancillary', quantity: 1 },
        { stream: 'ancillary', quantity: 1 },
      ]),
    ).toEqual({ stream: 'ancillary', size: 2 })
  })

  it('breaks a tie in favour of the stream listed first', () => {
    expect(
      pickScenePile([
        { stream: 'green', quantity: 2 },
        { stream: 'general', quantity: 2 },
      ]),
    ).toEqual({ stream: 'green', size: 2 })
  })

  it('skips services with no stream rather than guessing one', () => {
    expect(pickScenePile([{ stream: undefined, quantity: 4 }])).toEqual({ stream: 'general', size: 0 })
  })
})
