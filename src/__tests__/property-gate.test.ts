import { describe, it, expect } from 'vitest'

import { isPropertyBookable } from '@/lib/booking/property-gate'
import { isPropertyEligibleServer } from '@/lib/booking/property-gate-server'

describe('isPropertyBookable — client gate (16 Bolsover St), fail-OPEN', () => {
  it('treats an eligible property as bookable', () => {
    expect(isPropertyBookable({ is_eligible: true })).toBe(true)
  })

  it('treats an admin-marked ineligible property as not bookable', () => {
    expect(isPropertyBookable({ is_eligible: false })).toBe(false)
  })

  it('fails OPEN on a missing row/flag — the server enforces the hard gate', () => {
    expect(isPropertyBookable(null)).toBe(true)
    expect(isPropertyBookable(undefined)).toBe(true)
  })
})

describe('isPropertyEligibleServer — server gate, fail-CLOSED', () => {
  it('treats an eligible property as bookable', () => {
    expect(isPropertyEligibleServer({ is_eligible: true })).toBe(true)
  })

  it('treats an ineligible property as not bookable', () => {
    expect(isPropertyEligibleServer({ is_eligible: false })).toBe(false)
  })

  it('fails CLOSED on a missing/null flag — the opposite of the client helper', () => {
    expect(isPropertyEligibleServer({ is_eligible: null })).toBe(false)
    expect(isPropertyEligibleServer(null)).toBe(false)
    expect(isPropertyEligibleServer(undefined)).toBe(false)
  })
})
