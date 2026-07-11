import { describe, it, expect } from 'vitest'
import {
  canEditCollectionDetails,
  canRescheduleToTargetDate,
} from '@/lib/booking/collection-details-edit'
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
