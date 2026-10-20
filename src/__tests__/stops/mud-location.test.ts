import { describe, expect, it } from 'vitest'
import {
  buildOrderNotes,
  payloadDiffers,
  stopWasteLocation,
  type StopDiffDesired,
  type StopDiffExisting,
} from '@/lib/stops/stops'

/**
 * #580: a MUD booking's booking.location holds the strata's free-text
 * collection-point notes (createMudBooking copies
 * eligible_properties.waste_location_notes — "bins behind block B, use the side
 * gate"). The push only passed booking.location through when it was one of the
 * four fixed placements, so every MUD stop's crew card and OptimoRoute order
 * had no Location line: 225 of 254 live MUD bookings on 20/10/2026.
 */

const NOTES = 'Bins enclosure behind block B, enter via the side gate'

describe('stopWasteLocation', () => {
  it('passes a MUD booking\'s collection-point notes through verbatim', () => {
    expect(stopWasteLocation('MUD', NOTES)).toBe(NOTES)
  })

  it('trims them, and treats blank as no location', () => {
    expect(stopWasteLocation('MUD', `  ${NOTES}  `)).toBe(NOTES)
    expect(stopWasteLocation('MUD', '   ')).toBeNull()
    expect(stopWasteLocation('MUD', null)).toBeNull()
  })

  it('keeps a MUD booking\'s fixed placement as-is', () => {
    expect(stopWasteLocation('MUD', 'Front Verge')).toBe('Front Verge')
  })

  // booking.location is overloaded: legacy residential rows hold the street
  // ADDRESS there, which must never be shown as a Location line.
  it('still shows only a recognised placement for residential bookings', () => {
    expect(stopWasteLocation('Residential', 'Side Verge')).toBe('Side Verge')
    expect(stopWasteLocation('Residential', '7 Fixture Way, Anketell')).toBeNull()
  })

  it('still shows only a recognised placement for Illegal Dumping bookings', () => {
    expect(stopWasteLocation('Illegal Dumping', 'Behind the bus shelter')).toBeNull()
    expect(stopWasteLocation('Illegal Dumping', 'Driveway')).toBe('Driveway')
  })
})

describe('MUD notes reach the OptimoRoute order and refresh existing stops', () => {
  it('appear as the order\'s Location line', () => {
    const notes = buildOrderNotes([{ name: 'Bulk Waste', qty: 4 }], stopWasteLocation('MUD', NOTES), null, 'MUD')
    expect(notes.split('\n')).toContain(`Location: ${NOTES}`)
  })

  it('make a pushed MUD stop with no location differ, so it is refreshed once', () => {
    const base: StopDiffDesired = {
      collection_date_id: 'date-1',
      address: '1/20 Strata Way, Coogee WA 6166',
      latitude: -32.1,
      longitude: 115.76,
      services_summary: [{ name: 'Bulk Waste', qty: 4 }],
      waste_location: null,
      driver_notes: null,
    }
    const pushedBefore: StopDiffExisting = { ...base }
    const desired: StopDiffDesired = { ...base, waste_location: stopWasteLocation('MUD', NOTES) }
    expect(payloadDiffers(pushedBefore, desired)).toBe(true)
    expect(payloadDiffers({ ...pushedBefore, waste_location: NOTES }, desired)).toBe(false)
  })
})
