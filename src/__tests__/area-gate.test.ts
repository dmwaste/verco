import { describe, it, expect } from 'vitest'

import { isAreaBookable } from '@/lib/booking/area-gate'
import { isAreaBookableServer } from '@/lib/booking/area-gate-server'

describe('isAreaBookable — client gate (WS-A / VER-269), fail-OPEN', () => {
  it('treats an active area as bookable', () => {
    expect(isAreaBookable({ is_active: true })).toBe(true)
  })

  it('treats an inactive area as not bookable', () => {
    expect(isAreaBookable({ is_active: false })).toBe(false)
  })

  it('fails OPEN on a missing area embed — the server enforces the hard gate', () => {
    expect(isAreaBookable(null)).toBe(true)
    expect(isAreaBookable(undefined)).toBe(true)
  })
})

describe('isAreaBookableServer — server gate (WS-A / VER-269), fail-CLOSED', () => {
  it('treats an active area as bookable', () => {
    expect(isAreaBookableServer({ is_active: true })).toBe(true)
  })

  it('treats an inactive area as not bookable', () => {
    expect(isAreaBookableServer({ is_active: false })).toBe(false)
  })

  it('fails CLOSED on a missing/null flag — the opposite of the client helper', () => {
    expect(isAreaBookableServer({ is_active: null })).toBe(false)
    expect(isAreaBookableServer(null)).toBe(false)
    expect(isAreaBookableServer(undefined)).toBe(false)
  })
})
