'use client'

/**
 * ONE rolling-12 fetch feeding every sparkline (design 02/07): the
 * `get_reports_monthly` RPC returns long-format (month, series, value) rows
 * and every card shares the identical queryKey, so TanStack dedupes the
 * whole dashboard's sparkline needs into a single request. (The pre-release
 * typed seam was removed after the #254 release types regen.)
 */

import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { awstDateFromUtc } from '@/lib/booking/schedule-transition'
import { rolling12From } from '@/lib/reports/periods'

/**
 * Shared tuning for the monthly trend queries (this hook + the two dedicated
 * monthly hooks in sla-dashboard). Monthly aggregates: one retry and a long
 * staleTime — the TanStack defaults (3 retries, refetch-on-focus,
 * failed-is-always-stale) turned one unhealthy endpoint into a request storm
 * across 10 subscribed cards (measured: hundreds → 2 requests per load).
 */
export const MONTHLY_QUERY_OPTIONS = {
  retry: 1,
  staleTime: 10 * 60_000,
  refetchOnWindowFocus: false,
} as const

export function useReportsMonthly(clientId: string, area: string) {
  const supabase = createClient()
  const now = new Date()
  // Anchor in the queryKey: a month rollover in a long-lived tab re-keys the
  // cache instead of silently mixing windows (useMonthlyTrend convention).
  const anchor = rolling12From(now)
  const query = useQuery({
    queryKey: ['reports-monthly', clientId, area, anchor],
    enabled: !!clientId,
    ...MONTHLY_QUERY_OPTIONS,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_reports_monthly', {
        p_client_id: clientId,
        p_area_id: area || undefined,
        p_from: anchor,
        // Upper bound at the AWST today: Scheduled bookings for early next
        // month would otherwise mint a phantom future bucket in the tails.
        p_to: awstDateFromUtc(now),
      })
      if (error) throw new Error(error.message)
      return (data ?? []).map((r) => ({
        month: String(r.month),
        series: r.series,
        value: Number(r.value),
      }))
    },
  })
  // isSuccess matters for ZERO-FILLED consumers: a failed fetch must render
  // NO tail, never a flat-zero one (phantom "no bookings all year").
  return { rows: query.data ?? [], isSuccess: query.isSuccess, anchor, now }
}
