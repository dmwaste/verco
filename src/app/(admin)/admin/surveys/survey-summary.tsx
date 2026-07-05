'use client'

import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import {
  computeSurveyRating,
  computeServicePreference,
  computeResponseRate,
  type ResidentSatisfactionRow,
} from '@/lib/reports/resident-satisfaction'
import { averagePoints, csatSeries } from '@/lib/reports/monthly-series'
import { useReportsMonthly } from '../reports/use-reports-monthly'
import { Sparkline } from '../reports/sparkline'
import { DonutChart } from '../reports/donut-chart'

interface SurveySummaryProps {
  clientId: string
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col rounded-xl bg-white p-5 shadow-sm">
      <div className="mb-2 text-xs font-medium text-gray-500">{label}</div>
      {children}
    </div>
  )
}

export function SurveySummary({ clientId }: SurveySummaryProps) {
  const supabase = createClient()

  const { data } = useQuery({
    queryKey: ['survey-summary', clientId],
    queryFn: async () => {
      let createdQ = supabase.from('booking_survey').select('id', { count: 'exact', head: true })
      let submittedQ = supabase
        .from('booking_survey')
        .select('id', { count: 'exact', head: true })
        .not('submitted_at', 'is', null)
      let completedQ = supabase
        .from('booking')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'Completed')
      let rowsQ = supabase
        .from('booking_survey')
        .select('responses')
        .not('submitted_at', 'is', null)
        .limit(5000)
      if (clientId) {
        createdQ = createdQ.eq('client_id', clientId)
        submittedQ = submittedQ.eq('client_id', clientId)
        completedQ = completedQ.eq('client_id', clientId)
        rowsQ = rowsQ.eq('client_id', clientId)
      }
      const [created, submitted, completed, rowsRes] = await Promise.all([
        createdQ,
        submittedQ,
        completedQ,
        rowsQ,
      ])
      return {
        created: created.count ?? 0,
        submitted: submitted.count ?? 0,
        completed: completed.count ?? 0,
        rows: (rowsRes.data ?? []).map((r) => ({ responses: r.responses })) as ResidentSatisfactionRow[],
      }
    },
  })

  // Rolling-12 CSAT trend — reuses the reports RPC (one deduped fetch). Only
  // renders off a SUCCESSFUL fetch: a failed one must draw no tail, never a
  // flat-zero year. Mirrors the Overall Rating card on the Reports page.
  const monthly = useReportsMonthly(clientId, '')
  const overallTrend = monthly.isSuccess
    ? averagePoints(monthly.rows, csatSeries('overall', 'sum'), csatSeries('overall', 'n'))
    : []

  const rows = data?.rows ?? []
  const overall = computeSurveyRating(rows, 'overall_rating')
  const pref = computeServicePreference(rows)
  const rate = computeResponseRate({
    submitted: data?.submitted ?? 0,
    created: data?.created ?? 0,
    completed: data?.completed ?? 0,
  })

  return (
    <div className="grid grid-cols-2 gap-4 px-7 pb-1 pt-5 lg:grid-cols-4">
      <Card label="Overall satisfaction">
        {overall.isEmpty ? (
          <div className="font-[family-name:var(--font-heading)] text-display font-bold text-gray-300">—</div>
        ) : (
          <>
            <div className="font-[family-name:var(--font-heading)] text-display font-bold text-[#293F52]">
              {overall.avg === null ? '—' : (Math.round(overall.avg * 100) / 100).toFixed(2)}
            </div>
            <div className="mt-1 text-caption text-gray-500">
              {overall.n} response{overall.n === 1 ? '' : 's'}{overall.isLowN ? ' · building data' : ''}
            </div>
          </>
        )}
        {overallTrend.length > 0 && (
          <div className="mt-auto pt-3">
            <Sparkline points={overallTrend} caption="Avg rating · last 12 months" />
          </div>
        )}
      </Card>

      <Card label="Prefer this service">
        {pref.total === 0 ? (
          <div className="font-[family-name:var(--font-heading)] text-display font-bold text-gray-300">—</div>
        ) : (
          <div className="flex flex-1 items-center py-1">
            <DonutChart
              ariaLabel="Prefer this service over traditional verge collection"
              segments={[
                { label: 'Yes', value: pref.yes, color: '#10B981' },
                { label: 'No', value: pref.no, color: '#F59E0B' },
                { label: 'Indifferent', value: pref.indifferent, color: '#8FA5B8' },
              ]}
            />
          </div>
        )}
      </Card>

      <Card label="Responses">
        <div className="font-[family-name:var(--font-heading)] text-display font-bold text-[#293F52]">
          {rate.submitted}
        </div>
        <div className="mt-1 text-caption text-gray-500">
          {rate.created - rate.submitted} awaiting response
        </div>
      </Card>

      <Card label="Response rate">
        <div className="font-[family-name:var(--font-heading)] text-display font-bold text-[#293F52]">
          {rate.pct === null ? '—' : `${Math.round(rate.pct)}%`}
        </div>
        <div className="mt-1 text-caption text-gray-500">
          {rate.submitted} of {rate.completed} collections
        </div>
      </Card>
    </div>
  )
}
