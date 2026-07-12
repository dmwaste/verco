'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { Dialog } from '@base-ui/react/dialog'
import { createClient } from '@/lib/supabase/client'
import { buildSearchOrFilter } from '@/lib/search/or-filter'
import { getStatusStyle } from '@/lib/ui/status-styles'
import { isAutoRaised, autoRaisedContext } from '@/lib/refunds/auto-raised'
import Link from 'next/link'
import { SkeletonRow } from '@/components/ui/skeleton'
import { RowActionMenu } from '@/components/admin/row-action-menu'
import { invokeEfWithUserToken } from '@/lib/supabase/invoke-ef-client'
import { Th } from '@/components/admin/th'
import { Pagination } from '@/components/admin/pagination'
import { PageHeader } from '@/components/admin/page-header'
import { FilterBar, SearchInput, FilterSelect } from '@/components/admin/filter-bar'
import { StatusBadge } from '@/components/status-badge'

const STATUS_OPTIONS = ['Pending', 'Approved', 'Rejected'] as const

const PAGE_SIZE = 20

export function RefundsClient() {
  const supabase = createClient()
  const queryClient = useQueryClient()

  const [page, setPage] = useState(0)
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const [processingId, setProcessingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // Reject forfeits owed money permanently (no re-raise, resident not notified),
  // so it is gated behind a confirm dialog. Holds the row awaiting confirmation.
  const [rejectTarget, setRejectTarget] = useState<{ id: string; amountCents: number; reason: string } | null>(null)

  const { data: refundData, isLoading } = useQuery({
    queryKey: ['admin-refunds', statusFilter, search, page],
    queryFn: async () => {
      let query = supabase
        .from('refund_request')
        .select(
          `id, amount_cents, reason, status, stripe_refund_id, created_at, reviewed_at,
           booking:booking_id(id, ref),
           contact:contact_id(full_name),
           reviewer:reviewed_by(display_name)`,
          { count: 'exact' }
        )
        .order('created_at', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

      if (statusFilter) query = query.eq('status', statusFilter)
      if (search) {
        query = query.or(buildSearchOrFilter(['reason'], search))
      }

      const { data, count } = await query
      return { refunds: data ?? [], total: count ?? 0 }
    },
  })

  const refunds = refundData?.refunds ?? []
  const total = refundData?.total ?? 0

  async function handleAction(refundId: string, action: 'approve' | 'reject') {
    setActionError(null)
    setProcessingId(refundId)

    try {
      if (action === 'approve') {
        const result = await invokeEfWithUserToken(supabase, 'process-refund', { refund_request_id: refundId })
        if (!result.ok) {
          setActionError(`Refund failed: ${result.error}`)
          return
        }
      } else {
        // Reject — just update the DB status
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
          setActionError('Session expired. Please refresh the page and sign in again.')
          setProcessingId(null)
          return
        }

        // Guard on status='Pending' + require a row back: refund_request.status
        // has no state-machine trigger, so without this a stale list could reject
        // a row another admin already Approved — clobbering it to Rejected while
        // its stripe_refund_id stays set, hiding a completed refund. Zero rows
        // back = already actioned elsewhere (mirrors process-refund's approve
        // guard). No double-pay risk either way; this protects the audit record.
        const { data: rejected, error } = await supabase
          .from('refund_request')
          .update({
            status: 'Rejected',
            reviewed_by: user.id,
            reviewed_at: new Date().toISOString(),
          })
          .eq('id', refundId)
          .eq('status', 'Pending')
          .select('id')

        if (error) {
          setActionError(`Failed to reject: ${error.message}`)
          return
        }
        if (!rejected || rejected.length === 0) {
          setActionError('This refund was already actioned — refresh to see its current status.')
          return
        }
      }

      void queryClient.invalidateQueries({ queryKey: ['admin-refunds'] })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setProcessingId(null)
    }
  }

  async function confirmReject() {
    if (!rejectTarget) return
    const { id } = rejectTarget
    setRejectTarget(null)
    await handleAction(id, 'reject')
  }

  const rejectContext = rejectTarget ? autoRaisedContext(rejectTarget.reason) : null

  return (
    <>
      {/* Header */}
      <PageHeader title="Refund Requests" subtitle={`${total} requests`} />

      {/* Filters */}
      <FilterBar>
        <SearchInput
          value={search}
          onChange={(value) => { setSearch(value); setPage(0) }}
          placeholder="Search reason..."
          ariaLabel="Search refund requests"
        />

        <FilterSelect
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(0) }}
          aria-label="Filter by status"
        >
          <option value="">All Statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{getStatusStyle('refund', s).label}</option>
          ))}
        </FilterSelect>

      </FilterBar>

      {/* Error banner */}
      {actionError && (
        <div role="alert" className="mx-7 mb-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700">
          {actionError}
          <button type="button" onClick={() => setActionError(null)} className="ml-2 font-semibold underline">Dismiss</button>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 px-7 pb-6">
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                <Th>Booking</Th>
                <Th>Resident</Th>
                <Th>Amount</Th>
                <Th>Reason</Th>
                <Th>Status</Th>
                <Th>Stripe Ref</Th>
                <Th>Requested</Th>
                <Th>Reviewed By</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {isLoading && Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} columns={9} />
              ))}
              {!isLoading && refunds.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-sm text-gray-400">No refund requests found</td></tr>
              )}
              {refunds.map((refund) => {
                const booking = refund.booking as unknown as { id: string; ref: string } | null
                const contact = refund.contact as { full_name: string } | null
                const reviewer = refund.reviewer as { display_name: string | null } | null
                return (
                  <tr key={refund.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      {booking ? (
                        <Link
                          href={`/admin/bookings/${booking.id}`}
                          className="font-[family-name:var(--font-heading)] text-body-sm font-semibold text-[#293F52] hover:underline"
                        >
                          {booking.ref}
                        </Link>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-body-sm text-gray-600">
                      {contact?.full_name ?? '—'}
                    </td>
                    <td className="px-4 py-3 font-[family-name:var(--font-heading)] text-body-sm font-semibold text-[#293F52]">
                      ${(refund.amount_cents / 100).toFixed(2)}
                    </td>
                    <td className="max-w-[240px] px-4 py-3 text-xs">
                      {isAutoRaised(refund.reason) && (
                        <span className="mb-1 inline-flex items-center whitespace-nowrap rounded-full bg-status-info-bg px-2 py-0.5 text-caption font-semibold text-status-info">
                          Owed · auto-raised
                        </span>
                      )}
                      <div className="truncate text-gray-600">{refund.reason || '—'}</div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge entity="refund" status={refund.status} />
                    </td>
                    <td className="px-4 py-3 font-mono text-caption text-gray-400">
                      {refund.stripe_refund_id ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {format(new Date(refund.created_at), 'd MMM yyyy')}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {reviewer?.display_name ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      {refund.status === 'Pending' && (
                        <>
                          {processingId === refund.id ? (
                            <span className="text-xs text-gray-400">Processing...</span>
                          ) : (
                            <RowActionMenu
                              actions={[
                                { label: 'Approve & Refund', onSelect: () => handleAction(refund.id, 'approve') },
                                {
                                  label: 'Reject',
                                  onSelect: () =>
                                    setRejectTarget({ id: refund.id, amountCents: refund.amount_cents, reason: refund.reason ?? '' }),
                                  tone: 'danger',
                                },
                              ]}
                            />
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
      </div>

      {/* Reject confirmation — Reject permanently forfeits an owed refund. */}
      <Dialog.Root open={rejectTarget !== null} onOpenChange={(open) => { if (!open) setRejectTarget(null) }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Popup className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
              <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-[#FFF0F0]">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#E53E3E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <Dialog.Title className="font-[family-name:var(--font-heading)] text-lg font-bold text-[#293F52]">
                Reject this refund?
              </Dialog.Title>
              <p className="mt-1.5 text-body-sm leading-relaxed text-gray-500">
                {rejectContext ? (
                  <>This booking was already <span className="font-semibold text-[#293F52]">{rejectContext}</span>, so the <span className="font-semibold text-[#293F52]">${((rejectTarget?.amountCents ?? 0) / 100).toFixed(2)}</span> shown is already owed to the resident.</>
                ) : (
                  <>The <span className="font-semibold text-[#293F52]">${((rejectTarget?.amountCents ?? 0) / 100).toFixed(2)}</span> shown may be owed to the resident.</>
                )}{' '}
                Rejecting is permanent — the refund can’t be re-raised and the resident won’t be notified.
              </p>
              <div className="mt-5 flex gap-2.5">
                <Dialog.Close className="flex-1 rounded-xl border-[1.5px] border-gray-100 bg-white px-3.5 py-3 font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
                  Keep Request
                </Dialog.Close>
                <button
                  type="button"
                  onClick={confirmReject}
                  className="flex-1 rounded-xl bg-[#E53E3E] px-3.5 py-3 font-[family-name:var(--font-heading)] text-sm font-semibold text-white"
                >
                  Reject Refund
                </button>
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
