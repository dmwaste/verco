import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CallerMatch } from '@/app/(admin)/admin/lookup/caller-matches'

/**
 * What the caller lookup page does around the matches (VER-316): loads the
 * notes on every property the callers have booked (VER-321), each property
 * once, and records a view of every contact it shows (VER-322, ADR 0040).
 */

const { rpc, loadCallerMatches, loadPropertyNotes, getCurrentAdminClient, logContactViews } = vi.hoisted(() => ({
  rpc: vi.fn(),
  loadCallerMatches: vi.fn(),
  loadPropertyNotes: vi.fn(),
  getCurrentAdminClient: vi.fn(),
  logContactViews: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({ rpc })) }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/app/(admin)/admin/lookup/caller-matches', () => ({ loadCallerMatches }))
vi.mock('@/lib/property-notes/load', () => ({ loadPropertyNotes }))
vi.mock('@/lib/admin/current-client', () => ({ getCurrentAdminClient }))
vi.mock('@/lib/contacts/view-log', () => ({ logContactViews }))

import CallerLookupPage from '@/app/(admin)/admin/lookup/page'

const booking = (id: string, propertyId: string | null) => ({
  id,
  ref: id,
  status: 'Confirmed' as const,
  areaCode: 'KWN-1',
  collectionDates: [],
  address: '7 Fixture Way',
  propertyId,
})

const match = (id: string, bookings: CallerMatch['bookings']): CallerMatch => ({
  contact: { id, fullName: id, mobile: '+61412345678', email: `${id}@example.test` },
  bookings,
  tickets: [],
})

const searchParams = Promise.resolve({ phone: '+61412345678' })

describe('caller lookup page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rpc.mockResolvedValue({ data: 'contractor-staff' })
    loadPropertyNotes.mockResolvedValue([])
    getCurrentAdminClient.mockResolvedValue({ id: 'kwn', name: 'City of Kwinana' })
  })

  it('loads notes for each booked property once, across every caller on the number', async () => {
    loadCallerMatches.mockResolvedValue({
      ok: true,
      data: [
        match('c-a', [booking('b-1', 'p-1'), booking('b-2', 'p-1'), booking('b-3', null)]),
        match('c-b', [booking('b-4', 'p-2'), booking('b-5', 'p-1')]),
      ],
    })

    await CallerLookupPage({ searchParams })

    expect(loadPropertyNotes).toHaveBeenCalledWith(expect.anything(), ['p-1', 'p-2'])
    expect(getCurrentAdminClient).not.toHaveBeenCalled()
  })

  it('records a view of every contact it shows', async () => {
    loadCallerMatches.mockResolvedValue({ ok: true, data: [match('c-a', []), match('c-b', [])] })

    await CallerLookupPage({ searchParams })

    expect(logContactViews).toHaveBeenCalledWith(expect.anything(), ['c-a', 'c-b'], 'caller_lookup')
  })

  it.each([
    ['a miss', { ok: true, data: [] }],
    ['a failed lookup', { ok: false, error: 'statement timeout' }],
  ])('records no view on %s', async (_, result) => {
    loadCallerMatches.mockResolvedValue(result)

    await CallerLookupPage({ searchParams })

    expect(logContactViews).toHaveBeenCalledWith(expect.anything(), [], 'caller_lookup')
  })

  it('looks up the switcher’s council only on a miss, with no notes to load', async () => {
    loadCallerMatches.mockResolvedValue({ ok: true, data: [] })

    await CallerLookupPage({ searchParams })

    expect(loadPropertyNotes).toHaveBeenCalledWith(expect.anything(), [])
    expect(getCurrentAdminClient).toHaveBeenCalledTimes(1)
  })
})
