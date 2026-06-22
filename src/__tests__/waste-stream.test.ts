import { describe, it, expect } from 'vitest'

import {
  countByWasteStream,
  WASTE_STREAM_LABELS,
  WASTE_STREAM_ORDER,
} from '@/lib/reports/waste-stream'

describe('countByWasteStream (reports — WS-D / VER-272)', () => {
  it('sums quantities (no_services) per waste stream, ignoring null streams', () => {
    const counts = countByWasteStream([
      { stream: 'general', quantity: 3 },
      { stream: 'green', quantity: 1 },
      { stream: 'general', quantity: 2 },
      { stream: null, quantity: 5 },
      { stream: 'green', quantity: 1 },
      { stream: undefined, quantity: 9 },
      { stream: 'ancillary', quantity: 1 },
    ])
    // general 3+2=5, green 1+1=2, ancillary 1 — a 'General × 3' row counts as 3, not 1.
    expect(counts).toEqual({ general: 5, green: 2, ancillary: 1 })
  })

  it('returns an empty object for no items', () => {
    expect(countByWasteStream([])).toEqual({})
  })
})

describe('waste-stream display metadata', () => {
  it('has friendly labels for the four streams', () => {
    expect(WASTE_STREAM_LABELS.general).toBe('General waste')
    expect(WASTE_STREAM_LABELS.green).toBe('Green waste')
    expect(WASTE_STREAM_LABELS.ancillary).toBe('Ancillary')
    expect(WASTE_STREAM_LABELS.illegal_dumping).toBe('Illegal dumping')
  })

  it('orders general + green first (the Verge Valet streams)', () => {
    expect(WASTE_STREAM_ORDER.slice(0, 2)).toEqual(['general', 'green'])
  })
})
