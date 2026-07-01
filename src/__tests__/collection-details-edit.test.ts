import { describe, it, expect } from 'vitest'
import { canEditCollectionDetails } from '@/lib/booking/collection-details-edit'
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

  it('blocks client-tier roles from editing a Scheduled booking', () => {
    for (const role of CLIENT_ROLES) {
      expect(canEditCollectionDetails('Scheduled', role)).toBe(false)
    }
  })

  it('blocks editing for terminal / exception statuses regardless of role', () => {
    const nonEditable: BookingStatus[] = [
      'Cancelled',
      'Completed',
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
    const statuses: BookingStatus[] = [...PRE_DISPATCH, 'Scheduled', 'Cancelled']
    for (const status of statuses) {
      expect(canEditCollectionDetails(status, null)).toBe(false)
    }
  })

  it('denies non-admin roles in every status (defence in depth)', () => {
    // The panel and action gate to admin roles upstream, but the helper should
    // not hand edit rights to resident/field/ranger/strata on its own — even
    // pre-dispatch.
    const otherRoles: AppRole[] = ['field', 'ranger', 'resident', 'strata']
    const statuses: BookingStatus[] = [...PRE_DISPATCH, 'Scheduled']
    for (const role of otherRoles) {
      for (const status of statuses) {
        expect(canEditCollectionDetails(status, role)).toBe(false)
      }
    }
  })
})
