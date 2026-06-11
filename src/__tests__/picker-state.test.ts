import { describe, it, expect } from 'vitest'
import { pickerState, type PickerClient } from '@/app/landing/picker-state'

const KWN: PickerClient = {
  slug: 'kwn',
  name: 'City of Kwinana',
  custom_domain: 'kwntest.verco.au',
  service_name: 'VERCO Kwinana',
  primary_colour: '#0d295a',
  accent_colour: '#69a24c',
  logo_light_url: null,
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
