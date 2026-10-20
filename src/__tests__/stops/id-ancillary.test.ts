import { describe, expect, it } from 'vitest'
import {
  buildOrderNo,
  buildOrderNotes,
  ID_ANCILLARY_WASTE_TYPES,
  idAncillaryStop,
  idAncillaryTypes,
  idWasteItemsLine,
  itemStopKeys,
  orderEmail,
  shouldCancelOrphanStop,
  stopItemKey,
  vehicleFeaturesForStream,
  withIdAncillaryStop,
  type ServiceSummaryEntry,
  type WasteStream,
} from '@/lib/stops/stops'
import { ID_WASTE_TYPES, idWasteTypeLabel } from '@/lib/booking/id-options'

/**
 * #593: an Illegal Dumping booking stores the mattress / e-waste / whitegoods
 * the reporter ticked only as tags on booking.id_waste_types. Its single
 * booking_item is the illegal_dumping (bulk truck) pass, so no ancillary stop —
 * and no ANC order in OptimoRoute — ever existed: 23 of 117 ID jobs in the
 * 60 days to 20/10/2026 left those items for nobody.
 */

const idStop = {
  booking_id: 'booking-1',
  client_id: 'client-1',
  stream: 'illegal_dumping' as WasteStream,
  collection_date_id: 'date-1',
  address: '7 Fixture Way, Anketell WA 6167',
  latitude: -32.2,
  longitude: 115.85,
  services_summary: [{ name: 'Illegal dumping', qty: 1 }] as ServiceSummaryEntry[],
  waste_location: null,
  driver_notes: 'Behind the bus shelter',
  external_order_ref: 'KWN-4-TEST01-ID',
}

describe('ID_ANCILLARY_WASTE_TYPES — the ancillary ticks on the ID intake form', () => {
  it('are stored values the ID forms actually write (id-options.ts)', () => {
    for (const t of ID_ANCILLARY_WASTE_TYPES) expect(ID_WASTE_TYPES).toContain(t)
  })

  it('are exactly the ancillary-truck items (not bulk or green)', () => {
    expect([...ID_ANCILLARY_WASTE_TYPES].sort()).toEqual(['E-Waste', 'Mattress', 'Whitegoods'])
  })
})

describe('idAncillaryTypes', () => {
  it('returns the ancillary items ticked on an Illegal Dumping booking', () => {
    expect(idAncillaryTypes('Illegal Dumping', ['General / Mixed', 'Mattress', 'E-Waste'])).toEqual(['Mattress', 'E-Waste'])
  })

  it('returns them in the intake form order, whatever order they were stored in', () => {
    expect(idAncillaryTypes('Illegal Dumping', ['E-Waste', 'Whitegoods'])).toEqual(['Whitegoods', 'E-Waste'])
  })

  it('returns nothing when only bulk or green was ticked', () => {
    expect(idAncillaryTypes('Illegal Dumping', ['General / Mixed', 'Green Waste'])).toEqual([])
  })

  it('returns nothing for a residential or MUD booking, whatever the tags say', () => {
    expect(idAncillaryTypes('Residential', ['Mattress'])).toEqual([])
    expect(idAncillaryTypes('MUD', ['Mattress'])).toEqual([])
  })

  it('tolerates a missing tag array', () => {
    expect(idAncillaryTypes('Illegal Dumping', null)).toEqual([])
  })
})

describe('idAncillaryStop — the ID job\'s ancillary-truck pass', () => {
  it('derives an ancillary stop from the ID stop, listing the ticked items', () => {
    const anc = idAncillaryStop(idStop, 'KWN-4-TEST01', ['Mattress', 'E-Waste'])
    expect(anc).toEqual({
      ...idStop,
      stream: 'ancillary',
      services_summary: [
        { name: 'E-Waste', qty: 1 },
        { name: 'Mattress', qty: 1 },
      ],
      external_order_ref: buildOrderNo('KWN-4-TEST01', 'ancillary'),
    })
  })

  it('goes to the ancillary truck, not the bulk truck', () => {
    const anc = idAncillaryStop(idStop, 'KWN-4-TEST01', ['Whitegoods'])
    expect(vehicleFeaturesForStream(anc!.stream)).toEqual(['ANC'])
    expect(vehicleFeaturesForStream(idStop.stream)).toEqual(['BLK'])
  })

  it('keeps the same date, pin and crew notes as the ID stop', () => {
    const anc = idAncillaryStop(idStop, 'KWN-4-TEST01', ['Mattress'])!
    expect(anc.collection_date_id).toBe(idStop.collection_date_id)
    expect([anc.latitude, anc.longitude]).toEqual([idStop.latitude, idStop.longitude])
    expect(anc.driver_notes).toBe(idStop.driver_notes)
  })

  it('is null when no ancillary item was ticked', () => {
    expect(idAncillaryStop(idStop, 'KWN-4-TEST01', [])).toBeNull()
  })

  it('is null for any stop other than the ID pass', () => {
    expect(idAncillaryStop({ ...idStop, stream: 'general' }, 'KWN-4-TEST01', ['Mattress'])).toBeNull()
  })
})

describe('itemStopKeys — which stops a booking item keeps alive (pass-1 orphan check)', () => {
  it('a normal item keeps only its own stream on its date', () => {
    expect(itemStopKeys('date-1', 'general', [])).toEqual([stopItemKey('date-1', 'general')])
  })

  it('an ID item with ancillary ticks also keeps the ancillary stop on its date', () => {
    expect(itemStopKeys('date-1', 'illegal_dumping', ['Mattress'])).toEqual([
      stopItemKey('date-1', 'illegal_dumping'),
      stopItemKey('date-1', 'ancillary'),
    ])
  })

  it('does not cancel the derived ancillary stop while the ID item is still on its date', () => {
    const keys = new Set(itemStopKeys('date-1', 'illegal_dumping', ['Mattress']))
    expect(
      shouldCancelOrphanStop({
        stopStream: 'ancillary',
        stopDateId: 'date-1',
        desiredStreamsForBooking: null,
        bookingLive: true,
        currentItemKeys: keys,
      }),
    ).toBe(false)
  })

  it('cancels it once the ID item has moved to another date', () => {
    const keys = new Set(itemStopKeys('date-2', 'illegal_dumping', ['Mattress']))
    expect(
      shouldCancelOrphanStop({
        stopStream: 'ancillary',
        stopDateId: 'date-1',
        desiredStreamsForBooking: null,
        bookingLive: true,
        currentItemKeys: keys,
      }),
    ).toBe(true)
  })
})

describe('idWasteItemsLine — what was ticked, for the OptimoRoute notes', () => {
  it('uses the same label staff see for every ID waste type (id-options.ts parity)', () => {
    for (const t of ID_WASTE_TYPES) {
      expect(idWasteItemsLine('Illegal Dumping', [t])).toBe(idWasteTypeLabel(t))
    }
  })

  it('lists every ticked item with the labels staff see', () => {
    expect(idWasteItemsLine('Illegal Dumping', ['General / Mixed', 'Mattress'])).toBe(
      `${idWasteTypeLabel('General / Mixed')}, Mattress`,
    )
  })

  it('is null for a non-ID booking or an empty list', () => {
    expect(idWasteItemsLine('Residential', ['Mattress'])).toBeNull()
    expect(idWasteItemsLine('Illegal Dumping', [])).toBeNull()
  })

  it('shows on its own line straight after the Type line', () => {
    const notes = buildOrderNotes(
      [{ name: 'Illegal dumping', qty: 1 }],
      null,
      null,
      'Illegal Dumping',
      idWasteItemsLine('Illegal Dumping', ['Mattress', 'E-Waste']),
    )
    expect(notes.split('\n')).toEqual([
      'Type: Illegal Dumping',
      'Items: Mattress, E-Waste',
      'Services: Illegal dumping x1',
    ])
  })
})

describe('withIdAncillaryStop — the push EF\'s pass-1 builder', () => {
  const idBooking = { ref: 'KWN-4-TEST01', type: 'Illegal Dumping', id_waste_types: ['General / Mixed', 'Mattress'] }

  it('adds the ancillary stop to an ID job with ancillary items ticked', () => {
    const byStream = withIdAncillaryStop(new Map([['illegal_dumping' as WasteStream, idStop]]), idBooking)
    expect([...byStream.keys()]).toEqual(['illegal_dumping', 'ancillary'])
    expect(byStream.get('ancillary')!.services_summary).toEqual([{ name: 'Mattress', qty: 1 }])
  })

  it('leaves an ID job with only bulk ticked alone', () => {
    const byStream = withIdAncillaryStop(new Map([['illegal_dumping' as WasteStream, idStop]]), {
      ...idBooking,
      id_waste_types: ['General / Mixed'],
    })
    expect([...byStream.keys()]).toEqual(['illegal_dumping'])
  })

  it('never replaces a real ancillary stop', () => {
    const real = { ...idStop, stream: 'ancillary' as WasteStream, services_summary: [{ name: 'E-Waste', qty: 2 }] }
    const byStream = withIdAncillaryStop(
      new Map<WasteStream, typeof idStop>([['illegal_dumping', idStop], ['ancillary', real]]),
      idBooking,
    )
    expect(byStream.get('ancillary')).toBe(real)
  })

  it('leaves a residential booking alone', () => {
    const bulk = { ...idStop, stream: 'general' as WasteStream }
    const byStream = withIdAncillaryStop(new Map([['general' as WasteStream, bulk]]), {
      ref: 'KWN-4-TEST01',
      type: 'Residential',
      id_waste_types: ['Mattress'],
    })
    expect([...byStream.keys()]).toEqual(['general'])
  })
})

describe('orderEmail — one set of OptimoRoute emails per job', () => {
  it('leaves the email off an ID job\'s ancillary order', () => {
    expect(orderEmail('ancillary', 'Illegal Dumping', 'officer@example.com')).toBeUndefined()
  })

  it('keeps it on the ID job\'s own order and on every other booking\'s orders', () => {
    expect(orderEmail('illegal_dumping', 'Illegal Dumping', 'officer@example.com')).toBe('officer@example.com')
    expect(orderEmail('ancillary', 'Residential', 'resident@example.com')).toBe('resident@example.com')
  })
})
