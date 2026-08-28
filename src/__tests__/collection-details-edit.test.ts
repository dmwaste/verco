import { describe, it, expect } from 'vitest'
import {
  canEditCollectionDetails,
  canRescheduleToTargetDate, capacityBlocksMove, unitsByCategory } from '@/lib/booking/collection-details-edit'
import type { Database } from '@/lib/supabase/types'

type BookingStatus = Database['public']['Enums']['booking_status']
type AppRole = Database['public']['Enums']['app_role']

const ADMIN_ROLES: AppRole[] = [
  'contractor-admin',
  'contractor-staff',
  'client-admin',
  'client-staff',
]
const CONTRACTOR_ROLES: AppRole[] = ['contractor-admin', 'contractor-staff']
const CLIENT_ROLES: AppRole[] = ['client-admin', 'client-staff']
const PRE_DISPATCH: BookingStatus[] = ['Pending Payment', 'Submitted', 'Confirmed']

describe('canEditCollectionDetails', () => {
  it('allows every admin/staff role to edit pre-dispatch bookings', () => {
    for (const status of PRE_DISPATCH) {
      for (const role of ADMIN_ROLES) {
        expect(canEditCollectionDetails(status, role)).toBe(true)
      }
    }
  })

  it('lets contractor roles reschedule a Scheduled booking (VER-285)', () => {
    for (const role of CONTRACTOR_ROLES) {
      expect(canEditCollectionDetails('Scheduled', role)).toBe(true)
    }
  })

  it('lets contractor roles edit a Completed booking to fix a crew error (#378)', () => {
    // BR-0023: a "previous booking" collected on the wrong day is Completed;
    // only D&M (contractor-tier) staff may correct its collection date.
    for (const role of CONTRACTOR_ROLES) {
      expect(canEditCollectionDetails('Completed', role)).toBe(true)
    }
  })

  it('blocks client-tier roles from editing a Scheduled booking', () => {
    for (const role of CLIENT_ROLES) {
      expect(canEditCollectionDetails('Scheduled', role)).toBe(false)
    }
  })

  it('blocks client-tier roles from editing a Completed booking (#378)', () => {
    for (const role of CLIENT_ROLES) {
      expect(canEditCollectionDetails('Completed', role)).toBe(false)
    }
  })

  it('blocks editing for terminal / exception statuses regardless of role', () => {
    // Completed is intentionally NOT here — it is contractor-editable (#378).
    // The exception/rebook states keep their dedicated NCN/NP rebook flow.
    const nonEditable: BookingStatus[] = [
      'Cancelled',
      'Non-conformance',
      'Nothing Presented',
      'Rebooked',
      'Missed Collection',
    ]
    for (const status of nonEditable) {
      for (const role of ADMIN_ROLES) {
        expect(canEditCollectionDetails(status, role)).toBe(false)
      }
    }
  })

  it('denies a null role in every status', () => {
    const statuses: BookingStatus[] = [
      ...PRE_DISPATCH,
      'Scheduled',
      'Completed',
      'Cancelled',
    ]
    for (const status of statuses) {
      expect(canEditCollectionDetails(status, null)).toBe(false)
    }
  })

  it('denies non-admin roles in every status (defence in depth)', () => {
    // The panel and action gate to admin roles upstream, but the helper should
    // not hand edit rights to resident/field/ranger/strata on its own — even
    // pre-dispatch.
    const otherRoles: AppRole[] = ['field', 'ranger', 'resident', 'strata']
    const statuses: BookingStatus[] = [...PRE_DISPATCH, 'Scheduled', 'Completed']
    for (const role of otherRoles) {
      for (const status of statuses) {
        expect(canEditCollectionDetails(status, role)).toBe(false)
      }
    }
  })
})

describe('canRescheduleToTargetDate (D1 — #378)', () => {
  const TODAY = '2026-07-11'
  const FUTURE = '2026-08-01'
  const PAST = '2026-07-01'

  it('lets any admin role move onto an open, today-or-future date', () => {
    // The date dimension imposes no extra privilege; the status/role gate
    // (canEditCollectionDetails) already authorised the edit.
    for (const role of ADMIN_ROLES) {
      expect(
        canRescheduleToTargetDate(role, { is_open: true, date: FUTURE }, TODAY),
      ).toBe(true)
      expect(
        canRescheduleToTargetDate(role, { is_open: true, date: TODAY }, TODAY),
      ).toBe(true)
    }
  })

  it('lets contractor roles move onto a CLOSED (is_open=false) future date', () => {
    for (const role of CONTRACTOR_ROLES) {
      expect(
        canRescheduleToTargetDate(role, { is_open: false, date: FUTURE }, TODAY),
      ).toBe(true)
    }
  })

  it('lets contractor roles move onto a PAST (earlier) date', () => {
    for (const role of CONTRACTOR_ROLES) {
      expect(
        canRescheduleToTargetDate(role, { is_open: true, date: PAST }, TODAY),
      ).toBe(true)
    }
  })

  it('blocks client-tier roles from moving onto a CLOSED date', () => {
    for (const role of CLIENT_ROLES) {
      expect(
        canRescheduleToTargetDate(role, { is_open: false, date: FUTURE }, TODAY),
      ).toBe(false)
    }
  })

  it('blocks client-tier roles from moving onto a PAST date', () => {
    for (const role of CLIENT_ROLES) {
      expect(
        canRescheduleToTargetDate(role, { is_open: true, date: PAST }, TODAY),
      ).toBe(false)
    }
  })

  it('blocks a null role from a closed or past date', () => {
    expect(
      canRescheduleToTargetDate(null, { is_open: false, date: FUTURE }, TODAY),
    ).toBe(false)
    expect(
      canRescheduleToTargetDate(null, { is_open: true, date: PAST }, TODAY),
    ).toBe(false)
  })

  it('treats a closed AND past date as contractor-only', () => {
    expect(
      canRescheduleToTargetDate('contractor-admin', { is_open: false, date: PAST }, TODAY),
    ).toBe(true)
    expect(
      canRescheduleToTargetDate('client-admin', { is_open: false, date: PAST }, TODAY),
    ).toBe(false)
  })
})

describe('capacityBlocksMove (#426 — client-tier date moves respect capacity)', () => {
  const units = { bulk: 2, anc: 1, id: 0 }

  it('contractor roles are never capacity-gated (the #378 override stands)', () => {
    expect(capacityBlocksMove('contractor-admin', units, { bulk: 0, anc: 0, id: 0 })).toBe(false)
    expect(capacityBlocksMove('contractor-staff', units, { bulk: -3, anc: 0, id: 0 })).toBe(false)
  })

  it('client-tier: allowed when every used bucket has room', () => {
    expect(capacityBlocksMove('client-admin', units, { bulk: 2, anc: 1, id: 0 })).toBe(false)
    expect(capacityBlocksMove('client-staff', units, { bulk: 10, anc: 5, id: 0 })).toBe(false)
  })

  it('client-tier: blocked when any used bucket lacks room (a full date or over-booked date)', () => {
    expect(capacityBlocksMove('client-admin', units, { bulk: 1, anc: 1, id: 0 })).toBe(true)
    expect(capacityBlocksMove('client-admin', units, { bulk: 2, anc: 0, id: 0 })).toBe(true)
    expect(capacityBlocksMove('client-admin', units, { bulk: -1, anc: 9, id: 9 })).toBe(true)
  })

  it('buckets the booking does not use are ignored (a full ID bucket does not block a bulk-only booking)', () => {
    expect(capacityBlocksMove('client-admin', { bulk: 1, anc: 0, id: 0 }, { bulk: 1, anc: -5, id: -5 })).toBe(false)
  })

  it('null role is treated as client-tier (fails closed)', () => {
    expect(capacityBlocksMove(null, units, { bulk: 0, anc: 0, id: 0 })).toBe(true)
  })
})

describe('unitsByCategory', () => {
  it('sums no_services per bucket and ignores unknown codes', () => {
    expect(
      unitsByCategory([
        { no_services: 2, category_code: 'bulk' },
        { no_services: 1, category_code: 'bulk' },
        { no_services: 1, category_code: 'anc' },
        { no_services: 3, category_code: 'other' },
        { no_services: 1, category_code: null },
      ]),
    ).toEqual({ bulk: 3, anc: 1, id: 0 })
  })
})

// ── canEditIdDetails (ID booking edit, design 2026-08-28) ────────────────
import { canEditIdDetails } from '@/lib/booking/collection-details-edit'

const ALL_ROLES: AppRole[] = [
  'contractor-admin',
  'contractor-staff',
  'field',
  'client-admin',
  'client-staff',
  'ranger',
  'resident',
  'strata',
]
const EDITABLE_STATUSES: BookingStatus[] = [
  'Pending Payment',
  'Submitted',
  'Confirmed',
  'Scheduled',
  'Completed',
]
const NON_EDITABLE_STATUSES: BookingStatus[] = [
  'Cancelled',
  'Non-conformance',
  'Nothing Presented',
  'Rebooked',
  'Missed Collection',
]

describe('canEditIdDetails (contractor-only ID field editing)', () => {
  it('allows ONLY contractor roles, at every editable status — including Completed (UC1: unbounded)', () => {
    for (const status of EDITABLE_STATUSES) {
      for (const role of ALL_ROLES) {
        expect(canEditIdDetails(status, role)).toBe(
          role === 'contractor-admin' || role === 'contractor-staff',
        )
      }
    }
  })

  it('rejects every role on terminal/exception statuses (NCN/NP own their lifecycle)', () => {
    for (const status of NON_EDITABLE_STATUSES) {
      for (const role of ALL_ROLES) {
        expect(canEditIdDetails(status, role)).toBe(false)
      }
    }
  })

  it('null role fails closed everywhere', () => {
    for (const status of [...EDITABLE_STATUSES, ...NON_EDITABLE_STATUSES]) {
      expect(canEditIdDetails(status, null)).toBe(false)
    }
  })

  it('client-tier passes the generic gate pre-dispatch but never the ID gate (the two differ by design)', () => {
    expect(canEditCollectionDetails('Confirmed', 'client-admin')).toBe(true)
    expect(canEditIdDetails('Confirmed', 'client-admin')).toBe(false)
  })
})
