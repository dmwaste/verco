'use client'

import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import {
  computeSurveyRating,
  computeServicePreference,
  computeResponseRate,
  type ResidentSatisfactionRow,
} from '@/lib/reports/resident-satisfaction'

interface SurveySummaryProps {
  clientId: string
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-white p-5 shadow-sm">
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

  const rows = data?.rows ?? []
  const overall = computeSurveyRating(rows, 'overall_rating')
  const pref = computeServicePreference(rows)
  const rate = computeResponseRate({
    submitted: data?.submitted ?? 0,
    created: data?.created ?? 0,
    completed: data?.completed ?? 0,
  })

  const prefPct = (n: number) => (pref.total > 0 ? Math.round((n / pref.total) * 100) : 0)

  return (
    <div className="grid grid-cols-2 gap-4 px-7 pb-1 pt-5 lg:grid-cols-4">
      <Card label="Response rate">
        <div className="font-[family-name:var(--font-heading)] text-display font-bold text-[#293F52]">
          {rate.pct === null ? '—' : `${Math.round(rate.pct)}%`}
        </div>
        <div className="mt-1 text-caption text-gray-500">
          {rate.submitted} of {rate.completed} collections
        </div>
        {rate.gap && (
          <div className="mt-1.5 text-caption text-status-warn">
            ⚠ {rate.created} surveys created for {rate.completed} completed — check the completion emails
          </div>
        )}
      </Card>

      <Card label="Overall satisfaction">
        {overall.isEmpty ? (
          <div className="font-[family-name:var(--font-heading)] text-display font-bold text-gray-300">—</div>
        ) : (
          <>
            <div className="font-[family-name:var(--font-heading)] text-display font-bold text-[#293F52]">
              {overall.pct === null ? '—' : `${Math.round(overall.pct)}%`}
            </div>
            <div className="mt-1 text-caption text-gray-500">
              {overall.good} of {overall.n} rated 4★+{overall.isLowN ? ' · building data' : ''}
            </div>
          </>
        )}
      </Card>

      <Card label="Prefer this service">
        {pref.total === 0 ? (
          <div className="font-[family-name:var(--font-heading)] text-display font-bold text-gray-300">—</div>
        ) : (
          <>
            <div className="font-[family-name:var(--font-heading)] text-display font-bold text-[#293F52]">
              {prefPct(pref.yes)}%
            </div>
            <div className="mt-1 text-caption text-gray-500">
              {pref.yes} yes · {pref.no} no · {pref.indifferent} indifferent
            </div>
          </>
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
    </div>
  )
}
