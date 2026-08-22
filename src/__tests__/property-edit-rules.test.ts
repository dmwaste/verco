import { describe, expect, it } from 'vitest'
import { canMoveArea, normaliseAddress } from '@/lib/properties/edit-rules'

describe('canMoveArea (#502)', () => {
  it('client-tier roles can never move a property between areas', () => {
    expect(canMoveArea('client-admin', [])).toEqual({ ok: false, reason: 'contractor-only' })
    expect(canMoveArea('client-staff', [])).toEqual({ ok: false, reason: 'contractor-only' })
    expect(canMoveArea(null, [])).toEqual({ ok: false, reason: 'contractor-only' })
  })

  it('contractor can move when every booking is terminal (history stays keyed to the property)', () => {
    expect(canMoveArea('contractor-admin', ['Completed', 'Cancelled', 'Non-conformance', 'Nothing Presented', 'Rebooked'])).toEqual({ ok: true })
    expect(canMoveArea('contractor-staff', [])).toEqual({ ok: true })
  })

  it('blocked while any booking is Pending Payment / Submitted / Confirmed / Scheduled', () => {
    expect(canMoveArea('contractor-admin', ['Completed', 'Confirmed', 'Scheduled'])).toEqual({
      ok: false, reason: 'live-bookings', liveCount: 2,
    })
  })
})

describe('normaliseAddress', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normaliseAddress('  12  Smith   St,  Wellard ')).toBe('12 Smith St, Wellard')
  })
})
