import { describe, expect, it } from 'vitest'
import { isContractorStaff, canManageAllocations } from '@/lib/auth/roles'

describe('isContractorStaff', () => {
  it('is true only for contractor-tier staff (D&M ops)', () => {
    expect(isContractorStaff('contractor-admin')).toBe(true)
    expect(isContractorStaff('contractor-staff')).toBe(true)
  })

  it('is false for client-tier, field, ranger, resident, strata', () => {
    // client-admin=false is the run-sheet security boundary — the page guard is
    // the sole thing keeping councils off the operator surface (RLS lets
    // client-staff read their own stops).
    for (const role of [
      'client-admin',
      'client-staff',
      'field',
      'ranger',
      'resident',
      'strata',
    ]) {
      expect(isContractorStaff(role)).toBe(false)
    }
  })

  it('is false for a role-less caller (null/undefined)', () => {
    expect(isContractorStaff(null)).toBe(false)
    expect(isContractorStaff(undefined)).toBe(false)
  })

  it('is stricter than canManageAllocations — excludes client-admin', () => {
    expect(canManageAllocations('client-admin')).toBe(true)
    expect(isContractorStaff('client-admin')).toBe(false)
  })
})
