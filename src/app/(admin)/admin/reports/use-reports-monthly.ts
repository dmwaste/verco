'use client'

/**
 * ONE rolling-12 fetch feeding every sparkline (design 02/07): the
 * `get_reports_monthly` RPC returns long-format (month, series, value) rows
 * and every card shares the identical queryKey, so TanStack dedupes the
 * whole dashboard's sparkline needs into a single request.
 *
 * TYPED SEAM: the RPC ships in the SAME release as this consumer (migration
 * 20260702180000) but is absent from the generated types until the
 * post-release regen — the cast below is replaced by generated types then
 * (tracked on VER-298). Keeping the seam local avoids hand-editing
 * lib/supabase/types.ts, which would break the Types Freshness CI.
 */

import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { rolling12From } from '@/lib/reports/periods'
import type { MonthlySeriesRow } from '@/lib/reports/monthly-series'

type ReportsMonthlyRpc = (
  name: 'get_reports_monthly',
  args: { p_client_id: string; p_area_id?: string; p_from?: string },
) => PromiseLike<{ data: MonthlySeriesRow[] | null; error: { message: string } | null }>

export function useReportsMonthly(clientId: string, area: string) {
  const supabase = createClient()
  const now = new Date()
  // Anchor in the queryKey: a month rollover in a long-lived tab re-keys the
  // cache instead of silently mixing windows (useMonthlyTrend convention).
  const anchor = rolling12From(now)
  const query = useQuery({
    queryKey: ['reports-monthly', clientId, area, anchor],
    enabled: !!clientId,
    queryFn: async () => {
      const rpc = supabase.rpc.bind(supabase) as unknown as ReportsMonthlyRpc
      const { data, error } = await rpc('get_reports_monthly', {
        p_client_id: clientId,
        p_area_id: area || undefined,
        p_from: anchor,
      })
      if (error) throw new Error(error.message)
      return (data ?? []).map((r) => ({
        month: String(r.month),
        series: r.series,
        value: Number(r.value),
      }))
    },
  })
  return { rows: query.data ?? [], anchor, now }
}
