'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SkeletonRow } from '@/components/ui/skeleton'
import { retryNotification } from './actions'

const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  booking_created: 'Booking Created',
  booking_cancelled: 'Booking Cancelled',
  ncn_raised: 'NCN Raised',
  np_raised: 'Nothing Presented',
  completion_survey: 'Survey',
  payment_reminder: 'Payment Reminder',
  payment_expired: 'Payment Expired',
}

const TYPE_OPTIONS = [
  { value: '', label: 'All types' },
  { value: 'booking_created', label: 'Booking Created' },
  { value: 'booking_cancelled', label: 'Booking Cancelled' },
  { value: 'ncn_raised', label: 'NCN Raised' },
  { value: 'np_raised', label: 'Nothing Presented' },
  { value: 'completion_survey', label: 'Survey' },
  { value: 'payment_reminder', label: 'Payment Reminder' },
  { value: 'payment_expired', label: 'Payment Expired' },
]

interface NotificationsClientProps {
  clientId: string
}

export function NotificationsClient({ clientId }: NotificationsClientProps) {
  const supabase = createClient()
  const queryClient = useQueryClient()
  const [typeFilter, setTypeFilter] = useState('')
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set())
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({})

  const { data: logs, isLoading } = useQuery({
    queryKey: ['admin-notification-failures', clientId, typeFilter],
    queryFn: async () => {
      // Date.now() lives inside queryFn (impurity is expected here) rather
      // than at render scope. Result: react-hooks/purity stays happy, and
      // the queryKey doesn't need a stable date.
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

      let query = supabase
        .from('notification_log')
        .select(
          `id, booking_id, notification_type, to_address, error_message, created_at, status,
           booking:booking_id(ref)`
        )
        .eq('status', 'failed')
        .gt('created_at', sevenDaysAgo)
        .order('created_at', { ascending: false })

      if (clientId) query = query.eq('client_id', clientId)
      if (typeFilter) {
        query = query.eq('notification_type', typeFilter)
      }

      const { data, error } = await query
      if (error) {
        console.error('Failed to fetch notification failures:', error.message)
        return []
      }
      return data ?? []
    },
  })

  const handleRetry = async (logId: string) => {
    setRetryingIds((prev) => new Set(prev).add(logId))
    setRetryErrors((prev) => {
      const next = { ...prev }
      delete next[logId]
      return next
    })

    const result = await retryNotification(logId)

    setRetryingIds((prev) => {
      const next = new Set(prev)
      next.delete(logId)
      return next
    })

    if (!result.ok) {
      setRetryErrors((prev) => ({ ...prev, [logId]: result.error }))
    } else {
      queryClient.invalidateQueries({ queryKey: ['admin-notification-failures'] })
    }
  }

  const failedCount = logs?.length ?? 0

  return (
    <div>
      {/* Header */}
      <div className="border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <h1 className="font-[family-name:var(--font-heading)] text-title font-semibold text-gray-900">
          Notifications
        </h1>
        <p className="mt-1 text-body-sm text-gray-500">
          {isLoading
            ? 'Loading...'
            : failedCount === 0
              ? 'No failed notifications in the past 7 days'
              : `${failedCount} failed in the past 7 days`}
        </p>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 px-7 py-4">
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-body-sm text-gray-700"
        >
          {TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto px-7">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100 text-left">
              <th className="px-4 py-2 text-2xs font-semibold uppercase tracking-wider text-gray-400">Booking</th>
              <th className="px-4 py-2 text-2xs font-semibold uppercase tracking-wider text-gray-400">Type</th>
              <th className="px-4 py-2 text-2xs font-semibold uppercase tracking-wider text-gray-400">Recipient</th>
              <th className="px-4 py-2 text-2xs font-semibold uppercase tracking-wider text-gray-400">Error</th>
              <th className="px-4 py-2 text-2xs font-semibold uppercase tracking-wider text-gray-400">Time</th>
              <th className="px-4 py-2 text-2xs font-semibold uppercase tracking-wider text-gray-400"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <>
                {Array.from({ length: 5 }).map((_, i) => (
                  <SkeletonRow key={i} columns={6} />
                ))}
              </>
            )}

            {!isLoading && failedCount === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-body-sm text-gray-400">
                  No failed notifications in the past 7 days
                </td>
              </tr>
            )}

            {!isLoading &&
              (logs ?? []).map((log) => {
                const bookingRef =
                  log.booking && typeof log.booking === 'object' && 'ref' in log.booking
                    ? (log.booking as { ref: string }).ref
                    : null
                const isRetrying = retryingIds.has(log.id)
                const retryError = retryErrors[log.id]

                return (
                  <tr key={log.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="px-4 py-3 text-body-sm">
                      {bookingRef && log.booking_id ? (
                        <Link
                          href={`/admin/bookings/${log.booking_id}`}
                          className="font-medium text-[#293F52] underline decoration-gray-300 underline-offset-2 hover:decoration-[#293F52]"
                        >
                          {bookingRef}
                        </Link>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-body-sm text-gray-600">
                      {NOTIFICATION_TYPE_LABELS[log.notification_type] ?? log.notification_type}
                    </td>
                    <td className="px-4 py-3 text-body-sm text-gray-600">
                      {log.to_address === 'pending' ? (
                        <span className="text-gray-400">pending</span>
                      ) : (
                        log.to_address
                      )}
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 text-body-sm text-gray-500" title={log.error_message ?? ''}>
                      {log.error_message ?? '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-body-sm text-gray-400">
                      {formatDistanceToNow(new Date(log.created_at), { addSuffix: true })}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {retryError ? (
                        <span className="text-2xs text-red-500">{retryError.includes('not in failed') ? 'Already retried' : retryError}</span>
                      ) : (
                        <button
                          onClick={() => handleRetry(log.id)}
                          disabled={isRetrying}
                          className="rounded bg-[#293F52] px-3 py-1 text-2xs font-medium text-white transition-colors hover:bg-[#1e3040] disabled:opacity-50"
                        >
                          {isRetrying ? (
                            <span className="flex items-center gap-1.5">
                              <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                              </svg>
                              Retrying
                            </span>
                          ) : (
                            'Retry'
                          )}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
