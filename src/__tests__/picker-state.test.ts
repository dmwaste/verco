import { describe, it, expect } from 'vitest'
import {
  pickerState,
  attachSubClients,
  type PickerClient,
} from '@/app/landing/picker-state'

const KWN: PickerClient = {
  id: 'kwn-id',
  slug: 'kwn',
  name: 'City of Kwinana',
  custom_domain: 'kwntest.verco.au',
  service_name: 'VERCO Kwinana',
  primary_colour: '#0d295a',
  accent_colour: '#69a24c',
  logo_light_url: null,
  subClients: [],
}

describe('pickerState', () => {
  // An outage and an empty platform are different stories: the old page
  // showed "no councils configured" during Supabase errors.
  it('maps a query error to unavailable, not none-live', () => {
    expect(pickerState(null, { message: 'timeout' })).toEqual({
      kind: 'unavailable',
    })
    expect(pickerState([KWN], { message: 'timeout' })).toEqual({
      kind: 'unavailable',
    })
  })

  it('maps null rows without an explicit error to unavailable', () => {
    expect(pickerState(null, null)).toEqual({ kind: 'unavailable' })
  })

  it('maps zero rows to none-live', () => {
    expect(pickerState([], null)).toEqual({ kind: 'none-live' })
  })

  it('maps rows to cards', () => {
    expect(pickerState([KWN], null)).toEqual({
      kind: 'cards',
      clients: [KWN],
    })
  })
})

describe('attachSubClients', () => {
  const cols = {
    id: 'vv-id',
    slug: 'vergevalet',
    name: 'Verge Valet',
    custom_domain: 'vvtest.verco.au',
    service_name: 'Verge Valet',
    primary_colour: '#414042',
    accent_colour: '#72b75c',
    logo_light_url: null,
  }

  it('groups member names under the right client, preserving order', () => {
    const result = attachSubClients(
      [cols, { ...KWN }],
      [
        { client_id: 'vv-id', name: 'City of Fremantle' },
        { client_id: 'vv-id', name: 'City of Vincent' },
      ],
    )
    expect(result.map((c) => c.id)).toEqual(['vv-id', 'kwn-id'])
    expect(result[0]!.subClients).toEqual([
      'City of Fremantle',
      'City of Vincent',
    ])
    expect(result[1]!.subClients).toEqual([])
  })

  it('returns empty lists when the sub-client fetch failed (null)', () => {
    const result = attachSubClients([cols], null)
    expect(result[0]!.subClients).toEqual([])
  })
})
