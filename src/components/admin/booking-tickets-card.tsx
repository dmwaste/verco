import Link from 'next/link'
import { format } from 'date-fns'

/** Service tickets linked to a booking, shown on the admin booking detail. */
export interface BookingTicket {
  id: string
  display_id: string
  subject: string
  status: string
  category: string
  created_at: string
}

export function BookingTicketsCard({ tickets }: { tickets: BookingTicket[] }) {
  if (tickets.length === 0) return null
  return (
    <div className="rounded-xl bg-white p-5 shadow-sm">
      <h2 className="mb-3.5 font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
        Service Tickets
      </h2>
      <div className="flex flex-col gap-2">
        {tickets.map((t) => (
          <Link
            key={t.id}
            href={`/admin/service-tickets/${t.id}`}
            className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 p-3 hover:bg-gray-50"
          >
            <div className="min-w-0">
              <div className="truncate text-body-sm font-medium text-gray-900">{t.subject}</div>
              <div className="text-xs text-gray-500">
                {t.display_id} &middot; {t.category} &middot; {format(new Date(t.created_at), 'd MMM yyyy')}
              </div>
            </div>
            <span className="shrink-0 text-xs font-semibold text-gray-500">{t.status}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
