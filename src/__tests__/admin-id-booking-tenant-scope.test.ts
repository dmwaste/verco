import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ID_VOLUMES } from '@/lib/booking/id-options'

/**
 * Admin ID-booking switcher scoping (issue #377 / BR-0021).
 *
 * A contractor-tier admin's `accessible_client_ids()` set spans every client
 * under the contractor (Verge Valet AND City of Kwinana), so the RPC's own
 * tenant gate (client_id IN accessible_client_ids()) cannot tell the two
 * apart. The switcher selection lives in a cookie/header the DB never sees, so
 * `createAdminIdBooking` must reject a chosen area whose client_id ≠ the
 * currently-selected switcher client BEFORE calling the write RPC — the same
 * app-layer scope the sibling createMudBooking enforces (VER-281 class).
 *
 * These tests pin that contract with a recording Supabase mock: the load-bearing
 * case is "switcher on VV + a KWN area → rejected, and the RPC is never called".
 */

const VOLUME_WIRE = ID_VOLUMES.map((v) => `${v.label} (${v.sub})`)

const h = vi.hoisted(() => ({
  // The switcher client the acting admin currently has selected (null = none).
  currentClientId: 'vv' as string | null,
  // Fixture DB: area id → owning client id.
  areasByClient: { 'kwn-area': 'kwn', 'vv-area': 'vv' } as Record<string, string>,
  recorded: {
    rpc: [] as string[],
    areaFilters: [] as Array<[string, unknown]>,
  },
}))

vi.mock('@/lib/auth/server', () => ({
  // Staff gate passes — the tenant-isolation check is what's under test.
  validateStaffRole: () => Promise.resolve({ ok: true, data: 'contractor-admin' }),
}))

vi.mock('@/lib/admin/current-client', () => ({
  getCurrentAdminClient: () =>
    Promise.resolve(
      h.currentClientId
        ? { id: h.currentClientId, slug: 's', name: 'n', contractorId: 'dm' }
        : null
    ),
}))

vi.mock('@/lib/supabase/server', () => {
  function makeBuilder() {
    const filters: Record<string, unknown> = {}
    const builder: Record<string, unknown> = {}
    builder.select = () => builder
    builder.eq = (col: string, val: unknown) => {
      filters[col] = val
      h.recorded.areaFilters.push([col, val])
      return builder
    }
    // The scope guard reads the area filtered by (id, client_id). A cross-client
    // area yields no row — mirrors PostgREST returning null for .maybeSingle().
    builder.maybeSingle = () => {
      const areaId = filters['id'] as string
      const wantClient = filters['client_id']
      const owner = h.areasByClient[areaId]
      const matches = owner !== undefined && owner === wantClient
      return Promise.resolve({ data: matches ? { id: areaId } : null, error: null })
    }
    return builder
  }
  return {
    createClient: () =>
      Promise.resolve({
        from: () => makeBuilder(),
        rpc: (name: string) => {
          h.recorded.rpc.push(name)
          return Promise.resolve({
            data: { ref: 'ID-KWN-0001', booking_id: 'booking-1' },
            error: null,
          })
        },
      }),
  }
})

import { createAdminIdBooking } from '@/app/(admin)/admin/illegal-dumping/new/actions'
import type { IdIntakeSubmission } from '@/lib/booking/id-intake'

const KWN_AREA = 'a4d9b8c2-2222-4000-8000-000000000002'
const VV_AREA = 'a4d9b8c2-2222-4000-8000-000000000003'

function submission(areaId: string): IdIntakeSubmission {
  return {
    latitude: -32.27,
    longitude: 115.75,
    geo_address: '12 Test St, Safety Bay',
    collection_date_id: 'a4d9b8c2-1111-4000-8000-000000000001',
    collection_area_id: areaId,
    waste_types: ['General / Mixed'],
    volume: VOLUME_WIRE[0]!,
    description: 'Pile of mixed waste',
    photo_urls: [],
    notes: '',
  }
}

beforeEach(() => {
  h.currentClientId = 'vv'
  // Map the uuid area ids used in submissions onto their owning clients.
  h.areasByClient = { [KWN_AREA]: 'kwn', [VV_AREA]: 'vv' }
  h.recorded = { rpc: [], areaFilters: [] }
})

describe('createAdminIdBooking — switcher tenant isolation (#377)', () => {
  it('rejects an area belonging to a different client than the switcher, without writing', async () => {
    h.currentClientId = 'vv' // switcher on Verge Valet
    const result = await createAdminIdBooking(submission(KWN_AREA)) // KWN area

    expect(result.ok).toBe(false)
    // The write RPC must never run for a cross-client area.
    expect(h.recorded.rpc).not.toContain('create_id_booking_with_capacity_check')
  })

  it('scopes the area lookup to the switcher client id', async () => {
    h.currentClientId = 'vv'
    await createAdminIdBooking(submission(KWN_AREA))

    expect(h.recorded.areaFilters).toContainEqual(['client_id', 'vv'])
    expect(h.recorded.areaFilters).toContainEqual(['id', KWN_AREA])
  })

  it('allows an area that belongs to the switcher client (happy path preserved)', async () => {
    h.currentClientId = 'vv'
    const result = await createAdminIdBooking(submission(VV_AREA)) // VV area, VV switcher

    expect(result.ok).toBe(true)
    expect(h.recorded.rpc).toContain('create_id_booking_with_capacity_check')
  })

  it('fails closed when no switcher client is resolved, without writing', async () => {
    h.currentClientId = null
    const result = await createAdminIdBooking(submission(VV_AREA))

    expect(result.ok).toBe(false)
    expect(h.recorded.rpc).not.toContain('create_id_booking_with_capacity_check')
  })
})
