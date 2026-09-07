import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * updateMudAllocations — contractor-only post-collection correction of a MUD
 * booking's collected counts (booking_item.actual_services).
 *
 * The counts drive council invoicing (get_client_monthly_report bills
 * coalesce(actual_services, no_services)), so the action must: gate on
 * contractor tier + post-collection status, only touch items belonging to the
 * booking, skip unchanged items (no empty audit rows), and CAS each write on
 * the page-rendered booking_item.updated_at token VERBATIM.
 *
 * Recording Supabase mock: fixtures configure role/booking; every issued
 * booking_item update is recorded so tests can assert exactly what was (and
 * was not) written.
 */

const h = vi.hoisted(() => ({
  role: 'contractor-admin' as string | null,
  booking: null as {
    id: string
    type: string
    status: string
    booking_item: Array<{ id: string; actual_services: number | null }>
  } | null,
  // booking_item ids whose CAS should fail (updated_at token mismatch).
  conflictIds: new Set<string>(),
  recorded: {
    updates: [] as Array<{ id: string; actual_services: number; token: string }>,
    bookingFetches: 0,
  },
}))

vi.mock('@/lib/supabase/server', () => {
  function bookingBuilder() {
    const builder: Record<string, unknown> = {}
    builder.select = () => builder
    builder.eq = () => builder
    builder.single = () => {
      h.recorded.bookingFetches += 1
      return Promise.resolve({ data: h.booking, error: null })
    }
    return builder
  }
  function bookingItemBuilder() {
    let values: { actual_services: number } | null = null
    const filters: Record<string, unknown> = {}
    const builder: Record<string, unknown> = {}
    builder.update = (v: { actual_services: number }) => {
      values = v
      return builder
    }
    builder.eq = (col: string, val: unknown) => {
      filters[col] = val
      return builder
    }
    builder.select = () => builder
    builder.maybeSingle = () => {
      const id = filters['id'] as string
      h.recorded.updates.push({
        id,
        actual_services: values!.actual_services,
        token: filters['updated_at'] as string,
      })
      return Promise.resolve({
        data: h.conflictIds.has(id) ? null : { id },
        error: null,
      })
    }
    return builder
  }
  return {
    createClient: () =>
      Promise.resolve({
        from: (table: string) => (table === 'booking' ? bookingBuilder() : bookingItemBuilder()),
        rpc: (name: string) =>
          Promise.resolve(name === 'current_user_role' ? { data: h.role, error: null } : { data: null, error: null }),
      }),
  }
})

import { updateMudAllocations } from '@/app/(admin)/admin/bookings/[id]/actions'

const BOOKING_ID = 'b0000000-0000-4000-8000-000000000001'
const ITEM_GENERAL = 'c0000000-0000-4000-8000-000000000001'
const ITEM_GREEN = 'c0000000-0000-4000-8000-000000000002'
const FOREIGN_ITEM = 'c0000000-0000-4000-8000-00000000dead'
const TOKEN = '2026-09-01T02:03:04.123456+00:00'

function mudBooking(
  status = 'Completed',
  items: Array<{ id: string; actual_services: number | null }> = [
    { id: ITEM_GENERAL, actual_services: 6 },
    { id: ITEM_GREEN, actual_services: 2 },
  ],
) {
  return { id: BOOKING_ID, type: 'MUD', status, booking_item: items }
}

function item(id: string, actual_services: number, token = TOKEN) {
  return { booking_item_id: id, actual_services, expected_updated_at: token }
}

beforeEach(() => {
  h.role = 'contractor-admin'
  h.booking = mudBooking()
  h.conflictIds = new Set()
  h.recorded.updates = []
  h.recorded.bookingFetches = 0
})

describe('updateMudAllocations', () => {
  it('rejects non-contractor roles before touching the booking', async () => {
    for (const role of ['client-admin', 'client-staff', 'field', 'ranger', 'resident', 'strata', null]) {
      h.role = role
      const result = await updateMudAllocations(BOOKING_ID, [item(ITEM_GENERAL, 5)])
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('Only D&M staff can edit collected counts.')
    }
    expect(h.recorded.bookingFetches).toBe(0)
    expect(h.recorded.updates).toHaveLength(0)
  })

  it('rejects invalid payloads (empty, negative, non-integer, over-cap, missing token)', async () => {
    const bad = [
      [],
      [item(ITEM_GENERAL, -1)],
      [item(ITEM_GENERAL, 2.5)],
      [item(ITEM_GENERAL, 1000)],
      [{ booking_item_id: ITEM_GENERAL, actual_services: 5, expected_updated_at: '' }],
    ]
    for (const payload of bad) {
      const result = await updateMudAllocations(BOOKING_ID, payload)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('Invalid collected-count input.')
    }
    expect(h.recorded.updates).toHaveLength(0)
  })

  it('rejects non-MUD bookings', async () => {
    h.booking = { ...mudBooking(), type: 'Standard' }
    const result = await updateMudAllocations(BOOKING_ID, [item(ITEM_GENERAL, 5)])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('Not a MUD booking.')
    expect(h.recorded.updates).toHaveLength(0)
  })

  it('rejects non-post-collection statuses with a status-named error (Scheduled stays crew-owned)', async () => {
    for (const status of ['Pending Payment', 'Submitted', 'Confirmed', 'Scheduled', 'Cancelled', 'Rebooked']) {
      h.booking = mudBooking(status)
      const result = await updateMudAllocations(BOOKING_ID, [item(ITEM_GENERAL, 5)])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe(`Collected counts cannot be edited on a "${status}" booking.`)
      }
    }
    expect(h.recorded.updates).toHaveLength(0)
  })

  it('allows all three post-collection statuses (NCN/NP are billable per ADR 0017)', async () => {
    for (const status of ['Completed', 'Non-conformance', 'Nothing Presented']) {
      h.booking = mudBooking(status)
      const result = await updateMudAllocations(BOOKING_ID, [item(ITEM_GENERAL, 5)])
      expect(result.ok).toBe(true)
    }
  })

  it('rejects items that do not belong to the booking', async () => {
    const result = await updateMudAllocations(BOOKING_ID, [item(FOREIGN_ITEM, 5)])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('One or more items do not belong to this booking.')
    expect(h.recorded.updates).toHaveLength(0)
  })

  it('skips a fully unchanged payload without issuing any update (no empty audit rows)', async () => {
    const result = await updateMudAllocations(BOOKING_ID, [item(ITEM_GENERAL, 6), item(ITEM_GREEN, 2)])
    expect(result.ok).toBe(true)
    expect(h.recorded.updates).toHaveLength(0)
  })

  it('writes only the changed items, with the page token passed verbatim', async () => {
    const result = await updateMudAllocations(BOOKING_ID, [item(ITEM_GENERAL, 6), item(ITEM_GREEN, 3)])
    expect(result.ok).toBe(true)
    expect(h.recorded.updates).toEqual([{ id: ITEM_GREEN, actual_services: 3, token: TOKEN }])
  })

  it('treats a NULL current count as changed — setting a missing count is a primary use', async () => {
    h.booking = mudBooking('Nothing Presented', [{ id: ITEM_GENERAL, actual_services: null }])
    const result = await updateMudAllocations(BOOKING_ID, [item(ITEM_GENERAL, 0)])
    expect(result.ok).toBe(true)
    expect(h.recorded.updates).toEqual([{ id: ITEM_GENERAL, actual_services: 0, token: TOKEN }])
  })

  it('returns the reload error on a CAS conflict (stale updated_at token)', async () => {
    h.conflictIds = new Set([ITEM_GREEN])
    const result = await updateMudAllocations(BOOKING_ID, [item(ITEM_GREEN, 3)])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe(
        'This booking changed while you were editing — reload the page and re-apply your changes.',
      )
    }
  })
})
