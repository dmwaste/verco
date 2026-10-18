import Link from 'next/link'
import { format } from 'date-fns'
import { PageHeader } from '@/components/admin/page-header'
import { Th } from '@/components/admin/th'
import { Input } from '@/components/admin/form'
import { StatusBadge } from '@/components/status-badge'
import { awstDateFromUtc } from '@/lib/booking/schedule-transition'
import type { Result } from '@/lib/result'
import { formatPhoneDisplay } from './phone-lookup'
import type { CallerMatch } from './caller-matches'

interface CallerLookupViewProps {
  /** The number as it reached the page; empty when none was given. */
  query: string
  /** phoneLookupCandidates(query); empty when the query isn't a phone number. */
  candidates: string[]
  /** null when there was nothing to look up. */
  result: Result<CallerMatch[]> | null
  /** The switcher's council. /book books under it, whatever the caller's council is. */
  newBookingClientName?: string | null
}

const dayLabel = (yyyymmdd: string) => format(new Date(`${yyyymmdd}T00:00:00`), 'EEE d MMM yyyy')

/** Caller lookup (VER-316) — read-only; the page the Teams call pop opens. */
export function CallerLookupView({ query, candidates, result, newBookingClientName }: CallerLookupViewProps) {
  const display = candidates[0] ? formatPhoneDisplay(candidates[0]) : null
  const matches = result?.ok ? result.data : []

  return (
    <>
      <PageHeader title="Caller lookup" subtitle={display ?? undefined} />

      <div className="flex flex-col gap-4 px-7 py-5">
        <SearchForm
          action="/admin/lookup"
          name="phone"
          label="Look up a caller"
          placeholder="Caller's number"
          defaultValue={display ?? query.trim()}
        />

        {query.trim() && candidates.length === 0 && (
          <p className="text-body-sm text-gray-500">
            &ldquo;{query.trim()}&rdquo; isn&apos;t a phone number.
          </p>
        )}

        {result && !result.ok && (
          <p role="alert" className="rounded-lg bg-status-error-bg px-4 py-3 text-body-sm text-status-error">
            {result.error}. Try again, or search bookings below.
          </p>
        )}

        {result?.ok && matches.length === 0 && (
          <div className="flex flex-col gap-3 rounded-xl bg-white p-5 shadow-sm">
            <p className="text-body-sm font-semibold text-gray-900">No Verco contact for {display}</p>
            <div className="flex flex-wrap items-center gap-2.5">
              <SearchForm
                action="/admin/bookings"
                name="search"
                label="Search bookings"
                placeholder="Name, address or ref"
              />
              <Link
                href="/book?on_behalf=true"
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#293F52] px-4 py-2 text-body-sm font-semibold text-white"
              >
                + New Booking{newBookingClientName ? ` — ${newBookingClientName}` : ''}
              </Link>
            </div>
          </div>
        )}

        {matches.length > 1 && (
          <p className="rounded-lg bg-status-info-bg px-4 py-3 text-body-sm text-status-info">
            {matches.length} contacts share this number. Confirm the caller&apos;s name.
          </p>
        )}

        {matches.map((match) => (
          <ContactCard key={match.contact.id} match={match} />
        ))}
      </div>
    </>
  )
}

function ContactCard({ match: { contact, bookings, tickets } }: { match: CallerMatch }) {
  return (
    <section className="flex flex-col gap-4 rounded-xl bg-white p-5 shadow-sm">
      <div>
        <h2 className="font-[family-name:var(--font-heading)] text-subtitle font-semibold text-[#293F52]">
          {contact.fullName}
        </h2>
        <p className="mt-0.5 text-body-sm text-gray-500">
          {contact.mobile && <span>{formatPhoneDisplay(contact.mobile)}</span>}
          {contact.mobile && contact.email && <span> &middot; </span>}
          {contact.email && <span>{contact.email}</span>}
        </p>
      </div>

      <div>
        <h3 className="mb-2 text-caption font-semibold uppercase tracking-wide text-gray-500">
          Bookings ({bookings.length})
        </h3>
        {bookings.length === 0 ? (
          <p className="text-body-sm text-gray-400">No bookings</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-100">
            <table className="w-full border-collapse tabular-nums">
              <thead>
                <tr>
                  <Th className="px-4 py-2">Ref</Th>
                  <Th className="px-4 py-2">Status</Th>
                  <Th className="px-4 py-2">Area</Th>
                  <Th className="px-4 py-2">Collection Date</Th>
                  <Th className="px-4 py-2">Address</Th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => (
                  <tr key={b.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/admin/bookings/${b.id}`}
                        className="font-[family-name:var(--font-heading)] text-body-sm font-semibold text-[#293F52] hover:underline"
                      >
                        {b.ref}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge entity="booking" status={b.status} />
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">{b.areaCode ?? '—'}</td>
                    <td className="px-4 py-2.5 text-body-sm">
                      {b.collectionDates.length > 0 ? b.collectionDates.map(dayLabel).join(', ') : '—'}
                    </td>
                    <td className="max-w-[320px] truncate px-4 py-2.5 text-body-sm" title={b.address ?? undefined}>
                      {b.address ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-caption font-semibold uppercase tracking-wide text-gray-500">
          Service Tickets ({tickets.length})
        </h3>
        {tickets.length === 0 ? (
          <p className="text-body-sm text-gray-400">No service tickets</p>
        ) : (
          <div className="flex flex-col gap-2">
            {tickets.map((t) => (
              <Link
                key={t.id}
                // The ticket route resolves by display_id, not the row id.
                href={`/admin/service-tickets/${t.displayId}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 p-3 hover:bg-gray-50"
              >
                <div className="min-w-0">
                  <div className="truncate text-body-sm font-medium text-gray-900">{t.subject}</div>
                  <div className="text-xs text-gray-500">
                    {t.displayId} &middot; {dayLabel(awstDateFromUtc(new Date(t.createdAt)))}
                  </div>
                </div>
                <StatusBadge entity="ticket" status={t.status} />
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

/** Plain GET search form, so it works before any client JS has loaded. */
function SearchForm({
  action,
  name,
  label,
  placeholder,
  defaultValue,
}: {
  action: string
  name: string
  label: string
  placeholder: string
  defaultValue?: string
}) {
  return (
    <form role="search" aria-label={label} action={action} className="flex items-center gap-2">
      <Input
        type="search"
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-label={label}
        className="w-60"
      />
      <button
        type="submit"
        className="rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm font-semibold text-[#293F52] hover:bg-gray-50"
      >
        Search
      </button>
    </form>
  )
}
