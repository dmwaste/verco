import { describe, it, expect, vi, beforeEach } from 'vitest'

// Notification-gate coverage for updateCollectionDetails (#388 / #378). A
// date/location change on a CONFIRMED booking notifies the resident
// (booking_updated). A #378 post-dispatch correction (Scheduled/Completed) is
// DELIBERATELY silent — "your booking date is now <past date>" would only
// confuse — so no send-notification call fires. supabase + fetch are mocked.

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ getAll: () => [] }),
}))

const B1 = '9a1f6f2e-1c6b-4a1e-9f7d-2b8c3d4e5f60'
const CD_OLD = 'aa1f6f2e-1c6b-4a1e-9f7d-2b8c3d4e5f61'
const CD_NEW = 'bb1f6f2e-1c6b-4a1e-9f7d-2b8c3d4e5f62'

// Test-controlled state.
let role = 'client-admin'
let current: Record<string, unknown> | null
let targetDate: Record<string, unknown> | null

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: (name: string) =>
      name === 'current_user_role' ? Promise.resolve({ data: role }) : Promise.resolve({ data: null }),
    auth: {
      getSession: () => Promise.resolve({ data: { session: { access_token: 'tok' } } }),
    },
    from: (table: string) => {
      if (table === 'booking') {
        return {
          select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: current, error: current ? null : { message: 'not found' } }) }) }),
          update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: B1 }, error: null }) }) }) }),
        }
      }
      if (table === 'collection_date') {
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: targetDate, error: targetDate ? null : { message: 'not found' } }) }) }) }
      }
      if (table === 'booking_item') {
        return { update: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [{ id: 'bi-1' }], error: null }) }) }) }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

import { updateCollectionDetails } from '@/app/(admin)/admin/bookings/[id]/actions'

interface FetchCall { url: string; body: Record<string, unknown> }
let fetchCalls: FetchCall[] = []

beforeEach(() => {
  fetchCalls = []
  // Open, far-future target so the reschedule date-gate passes for any role.
  targetDate = { id: CD_NEW, date: '2099-01-01', is_open: true, collection_area_id: 'area-1' }
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    fetchCalls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }
  })
})

describe('updateCollectionDetails — resident notification gate', () => {
  it('sends booking_updated when a Confirmed booking’s date changes', async () => {
    role = 'client-admin'
    current = {
      status: 'Confirmed',
      location: 'Front Verge',
      collection_area_id: 'area-1',
      booking_item: [{ id: 'bi-1', collection_date_id: CD_OLD }],
    }
    // Location unchanged; only the date moves.
    const res = await updateCollectionDetails(B1, { location: 'Front Verge', collection_date_id: CD_NEW })
    expect(res.ok).toBe(true)

    const notify = fetchCalls.filter((c) => c.url.includes('/send-notification'))
    expect(notify).toHaveLength(1)
    expect(notify[0]!.body.type).toBe('booking_updated')
    expect(notify[0]!.body.booking_id).toBe(B1)
    expect((notify[0]!.body.edit_ref as string).length).toBeGreaterThan(0)
  })

  it('does NOT notify on a #378 Completed date correction (contractor override)', async () => {
    // Only contractor roles may edit a Completed booking (#378); the change
    // still applies, but the resident is intentionally not emailed.
    role = 'contractor-admin'
    current = {
      status: 'Completed',
      location: 'Front Verge',
      collection_area_id: 'area-1',
      booking_item: [{ id: 'bi-1', collection_date_id: CD_OLD }],
    }
    const res = await updateCollectionDetails(B1, { location: 'Front Verge', collection_date_id: CD_NEW })
    expect(res.ok).toBe(true)

    // send-notification is the only fetch the action ever makes — none here.
    expect(fetchCalls.filter((c) => c.url.includes('/send-notification'))).toHaveLength(0)
  })
})
