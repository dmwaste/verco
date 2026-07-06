import Link from 'next/link'
import { format } from 'date-fns'
import { StatusBadge } from '@/components/status-badge'
import { OpenInvestigationButton } from '@/components/admin/open-investigation-button'
import { OPENABLE_STATUSES } from '@/lib/exceptions/status'

/**
 * One booking can carry several exception records — one per stop (waste stream),
 * even both an NCN and an NP — so this renders ALL of them, newest first.
 * Renders nothing when there are none.
 */
export interface AdminExceptionRecord {
  id: string
  kind: 'ncn' | 'np'
  status: string
  reason: string | null
  stream: string | null
  photos: string[]
  reported_at: string
  contractor_fault?: boolean
}

export function ExceptionsCard({ records }: { records: AdminExceptionRecord[] }) {
  if (records.length === 0) return null
  return (
    <div className="rounded-xl bg-white p-5 shadow-sm">
      <h2 className="mb-3.5 font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
        Exceptions
      </h2>
      <div className="flex flex-col gap-3">
        {records.map((r) => {
          const isNcn = r.kind === 'ncn'
          const href = `/admin/${isNcn ? 'non-conformance' : 'nothing-presented'}/${r.id}`
          return (
            <div key={`${r.kind}-${r.id}`} className="rounded-lg border border-gray-100 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center rounded-md px-2 py-0.5 text-2xs font-bold ${
                    isNcn ? 'bg-status-error-bg text-status-error' : 'bg-status-warn-bg text-status-warn'
                  }`}
                >
                  {isNcn ? 'NCN' : 'NP'}
                </span>
                <StatusBadge entity={r.kind} status={r.status} />
                {r.stream && <span className="text-xs text-gray-500">{r.stream}</span>}
              </div>
              <div className="flex flex-col gap-1 text-body-sm">
                {isNcn && r.reason && (
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">Reason</span>
                    <span className="font-medium text-gray-900">{r.reason}</span>
                  </div>
                )}
                {!isNcn && (
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">Fault</span>
                    <span className="font-medium text-gray-900">
                      {r.contractor_fault ? 'Contractor' : 'Resident'}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Reported</span>
                  <span className="font-medium text-gray-900">
                    {format(new Date(r.reported_at), 'd MMM yyyy')}
                  </span>
                </div>
                {r.photos.length > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">Photos</span>
                    <span className="text-gray-500">{r.photos.length}</span>
                  </div>
                )}
              </div>
              <div className="mt-2.5 flex items-center gap-2">
                {(OPENABLE_STATUSES as readonly string[]).includes(r.status) && (
                  <OpenInvestigationButton kind={r.kind} noticeId={r.id} />
                )}
                <Link
                  href={href}
                  className="inline-flex items-center rounded-md border-[1.5px] border-gray-100 bg-white px-3 py-1 text-xs font-semibold text-[#293F52]"
                >
                  View
                </Link>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
