'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { format } from 'date-fns'
import { DetailHeader } from '@/components/admin/detail-header'
import { StatusBadge } from '@/components/status-badge'
import { AuditTimeline } from '@/components/audit-timeline'
import { SURVEY_QUESTIONS, surveySections } from '@/lib/survey/questions'
import type { ResolvedAuditEntry } from '@/lib/audit/resolve'

export interface SurveyDetail {
  id: string
  submitted_at: string | null
  responses: unknown
  created_at: string
  booking: {
    id: string
    ref: string
    status: string
    collection_area: { name: string; code: string } | null
    eligible_properties: { formatted_address: string | null; address: string } | null
    booking_item: Array<{
      no_services: number
      is_extra: boolean
      service: { name: string }
      collection_date: { date: string }
    }>
  } | null
}

function Stars({ value }: { value: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((s) => (
        <svg key={s} width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
            fill={s <= value ? '#FF8C42' : '#E8E8E8'}
          />
        </svg>
      ))}
    </span>
  )
}

function Answer({ type, value }: { type: string; value: unknown }) {
  const present = value !== undefined && value !== null && value !== ''
  if (!present) return <span className="text-gray-400">Not answered</span>
  if (type === 'rating') {
    const n = Number(value)
    if (Number.isInteger(n) && n >= 1 && n <= 5) return <Stars value={n} />
    return <span className="text-gray-400">Not answered</span>
  }
  return <span className="whitespace-pre-wrap text-gray-900">{String(value)}</span>
}

export function SurveyDetailClient({
  survey,
  auditLogs,
}: {
  survey: SurveyDetail
  auditLogs: ResolvedAuditEntry[]
}) {
  const listParams = useSearchParams()
  const fromQuery = listParams.get('from')
  const backHref = fromQuery ? `/admin/surveys?${fromQuery}` : '/admin/surveys'

  const booking = survey.booking
  const address =
    booking?.eligible_properties?.formatted_address ?? booking?.eligible_properties?.address ?? '—'
  const submitted = survey.submitted_at !== null
  const responses = (survey.responses ?? {}) as Record<string, unknown>
  const collectionDate = booking?.booking_item?.[0]?.collection_date?.date ?? null

  const knownIds = new Set(SURVEY_QUESTIONS.map((q) => q.id))
  const legacyKeys = Object.keys(responses).filter((k) => !knownIds.has(k))

  return (
    <>
      <DetailHeader
        backHref={backHref}
        backLabel="Surveys"
        title={booking?.ref ?? 'Survey'}
        subtitle={address}
      >
        <StatusBadge entity="survey" status={submitted ? 'Submitted' : 'Pending'} />
      </DetailHeader>

      <div className="grid grid-cols-1 gap-0 px-7 py-5 lg:grid-cols-2">
        <div className="space-y-3 lg:border-r lg:border-gray-100 lg:pr-5">
          <h2 className="mb-3 text-subtitle font-semibold text-[#293F52]">Booking</h2>
          <Field label="Reference">
            {booking ? (
              <Link href={`/admin/bookings/${booking.id}`} className="text-[#293F52] hover:underline">
                {booking.ref}
              </Link>
            ) : '—'}
          </Field>
          <Field label="Area">{booking?.collection_area?.code ?? '—'}</Field>
          <Field label="Address">{address}</Field>
          <Field label="Collection date">
            {collectionDate ? format(new Date(collectionDate + 'T00:00:00'), 'EEE d MMM yyyy') : '—'}
          </Field>
          <Field label="Submitted">
            {survey.submitted_at ? format(new Date(survey.submitted_at), 'd MMM yyyy, h:mmaaa') : 'Not yet submitted'}
          </Field>
        </div>

        <div className="mt-5 space-y-4 lg:mt-0 lg:pl-5">
          <h2 className="mb-3 text-subtitle font-semibold text-[#293F52]">Responses</h2>
          {surveySections().map((section) => (
            <div key={section.section} className="space-y-2.5">
              <div className="text-caption font-semibold uppercase tracking-wide text-gray-500">
                {section.section}
              </div>
              {section.questions.map((q) => (
                <div key={q.id}>
                  <div className="text-body-sm font-medium text-gray-700">{q.label}</div>
                  <div className="text-body-sm">
                    <Answer type={q.type} value={responses[q.id]} />
                  </div>
                </div>
              ))}
            </div>
          ))}

          {legacyKeys.length > 0 && (
            <div className="space-y-2.5 border-t border-gray-100 pt-3">
              <div className="text-caption font-semibold uppercase tracking-wide text-gray-400">
                Legacy (not in current question set)
              </div>
              {legacyKeys.map((k) => (
                <div key={k}>
                  <div className="text-body-sm font-medium text-gray-500">{k}</div>
                  <div className="text-body-sm text-gray-600">{String(responses[k])}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <AuditTimeline entries={auditLogs} maxVisible={10} />
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-caption uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-0.5 text-body-sm text-gray-900">{children}</div>
    </div>
  )
}
