import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { REFUND_REASONS } from '@/lib/refunds/auto-raised'

// Reject permanently forfeits an owed refund (no re-raise, resident not
// notified), so it is confirm-gated (PR #404) and guarded on status='Pending'
// (a stale list must not clobber a row another admin already Approved). This
// drives those two behaviours through the real component.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/supabase/invoke-ef-client', () => ({ invokeEfWithUserToken: vi.fn() }))

let supabaseMock: unknown
vi.mock('@/lib/supabase/client', () => ({ createClient: () => supabaseMock }))

import { RefundsClient } from '@/app/(admin)/admin/refunds/refunds-client'

interface RefundRow {
  id: string
  amount_cents: number
  reason: string
  status: string
  stripe_refund_id: string | null
  created_at: string
  reviewed_at: string | null
  booking: { id: string; ref: string } | null
  contact: { full_name: string } | null
  reviewer: { display_name: string | null } | null
}

function pendingAutoRaisedRow(overrides: Partial<RefundRow> = {}): RefundRow {
  return {
    id: 'refund-1',
    amount_cents: 5500,
    reason: REFUND_REASONS.staffCancellation,
    status: 'Pending',
    stripe_refund_id: null,
    created_at: '2026-07-11T00:00:00.000Z',
    reviewed_at: null,
    booking: { id: 'b-1', ref: 'KWN-2026-000123' },
    contact: { full_name: 'Jo Bloggs' },
    reviewer: null,
    ...overrides,
  }
}

/**
 * Chainable Supabase stub. The list query (`select→order→range`) and the reject
 * mutation (`update→eq→eq→select`) both terminate in an awaited builder; the
 * builder disambiguates by whether `.update()` was called.
 */
function makeSupabase(opts: {
  refunds: RefundRow[]
  rejectRows?: Array<{ id: string }>
  rejectError?: { message: string } | null
}) {
  const updateSpy = vi.fn()
  const getUser = vi.fn(async () => ({ data: { user: { id: 'admin-1' } } }))

  function from() {
    let mode: 'read' | 'update' = 'read'
    const builder: Record<string, unknown> = {
      select: vi.fn(() => builder),
      order: vi.fn(() => builder),
      range: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      or: vi.fn(() => builder),
      update: vi.fn((payload: unknown) => {
        mode = 'update'
        updateSpy(payload)
        return builder
      }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const result =
          mode === 'update'
            ? { data: opts.rejectError ? null : (opts.rejectRows ?? []), error: opts.rejectError ?? null }
            : { data: opts.refunds, count: opts.refunds.length, error: null }
        return Promise.resolve(result).then(resolve, reject)
      },
    }
    return builder
  }

  return { supabase: { from: vi.fn(from), auth: { getUser } }, updateSpy, getUser }
}

function renderRefunds() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RefundsClient />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  supabaseMock = undefined
})

describe('RefundsClient — Owed badge', () => {
  it('shows the "Owed · auto-raised" badge for an auto-raised Pending refund', async () => {
    const { supabase } = makeSupabase({ refunds: [pendingAutoRaisedRow()] })
    supabaseMock = supabase
    renderRefunds()

    expect(await screen.findByText(/Owed · auto-raised/)).toBeInTheDocument()
  })

  it('does NOT show the Owed badge for a discretionary (unknown-reason) refund', async () => {
    const { supabase } = makeSupabase({
      refunds: [pendingAutoRaisedRow({ reason: 'Goodwill gesture' })],
    })
    supabaseMock = supabase
    renderRefunds()

    // The row itself renders (its reason text), but no Owed badge.
    expect(await screen.findByText('Goodwill gesture')).toBeInTheDocument()
    expect(screen.queryByText(/Owed · auto-raised/)).not.toBeInTheDocument()
  })
})

describe('RefundsClient — reject confirm gate', () => {
  async function openRejectMenu() {
    await screen.findByText(/Owed · auto-raised/)
    fireEvent.click(screen.getByLabelText('Open actions menu'))
    fireEvent.click(await screen.findByText('Reject'))
  }

  it('clicking Reject opens the confirm dialog instead of rejecting immediately', async () => {
    const { supabase, updateSpy } = makeSupabase({
      refunds: [pendingAutoRaisedRow()],
      rejectRows: [{ id: 'refund-1' }],
    })
    supabaseMock = supabase
    renderRefunds()

    await openRejectMenu()

    expect(await screen.findByText('Reject this refund?')).toBeInTheDocument()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('confirming the dialog rejects the refund exactly once (status guarded to Pending)', async () => {
    const { supabase, updateSpy } = makeSupabase({
      refunds: [pendingAutoRaisedRow()],
      rejectRows: [{ id: 'refund-1' }],
    })
    supabaseMock = supabase
    renderRefunds()

    await openRejectMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'Reject Refund' }))

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1))
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'Rejected' }))
  })

  it('Keep Request closes the dialog without rejecting', async () => {
    const { supabase, updateSpy } = makeSupabase({
      refunds: [pendingAutoRaisedRow()],
      rejectRows: [{ id: 'refund-1' }],
    })
    supabaseMock = supabase
    renderRefunds()

    await openRejectMenu()
    await screen.findByText('Reject this refund?')
    fireEvent.click(screen.getByRole('button', { name: 'Keep Request' }))

    await waitFor(() =>
      expect(screen.queryByText('Reject this refund?')).not.toBeInTheDocument(),
    )
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('surfaces "already actioned" when the Pending-guarded reject matches zero rows', async () => {
    const { supabase } = makeSupabase({
      refunds: [pendingAutoRaisedRow()],
      rejectRows: [], // another admin already actioned it → zero rows back
    })
    supabaseMock = supabase
    renderRefunds()

    await openRejectMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'Reject Refund' }))

    expect(await screen.findByText(/already actioned/)).toBeInTheDocument()
  })
})
