import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The contractor-only page guard is the SOLE access boundary for admin run
 * sheets: the proxy admits client-tier to /admin/*, the (admin) layout has no
 * role guard, and collection_stop RLS lets client-staff read their own stops.
 * So if either page stopped redirecting a non-contractor role, councils would
 * see the operator surface. This pins the predicate→redirect wiring that the
 * OTP-only E2E can't exercise (see admin-run-sheets.spec.ts).
 */

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ rpc })),
}))

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    // Real next/navigation redirect throws to halt rendering — mirror that so
    // the page stops before touching the (mocked-away) data layer.
    throw new Error(`REDIRECT:${url}`)
  }),
}))

import { redirect } from 'next/navigation'
import RunSheetsListPage from '@/app/(admin)/admin/run-sheets/page'
import RunSheetDetailPage from '@/app/(admin)/admin/run-sheets/[date]/[driver]/page'

const DENIED_ROLES = ['client-admin', 'client-staff', 'ranger', 'resident', 'strata', null] as const

describe('admin run-sheets contractor-only guard', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each(DENIED_ROLES)('list page redirects role=%s to /admin', async (role) => {
    rpc.mockResolvedValue({ data: role })
    await expect(
      RunSheetsListPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('REDIRECT:/admin')
    expect(redirect).toHaveBeenCalledWith('/admin')
  })

  it.each(DENIED_ROLES)('detail page redirects role=%s to /admin', async (role) => {
    rpc.mockResolvedValue({ data: role })
    await expect(
      RunSheetDetailPage({ params: Promise.resolve({ date: '2026-07-08', driver: 'KWN1' }) }),
    ).rejects.toThrow('REDIRECT:/admin')
    expect(redirect).toHaveBeenCalledWith('/admin')
  })
})
