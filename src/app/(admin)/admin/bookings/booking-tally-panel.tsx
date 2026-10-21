'use client'

import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { Th } from '@/components/admin/th'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { Result } from '@/lib/result'
import type { Database } from '@/lib/supabase/types'
import { buildTally, parseTally, type Tally, type TallyRow } from './tally-model'

type BookingStatus = Database['public']['Enums']['booking_status']
type BookingType = Database['public']['Enums']['booking_type']

interface BookingTallyPanelProps {
  clientId: string
  statuses: BookingStatus[]
  areaIds: string[]
  types: BookingType[]
  serviceIds: string[]
  dateFrom: string
  dateTo: string
  /** The free-text search is in use — totals hide rather than match on names
   *  or addresses (ADR 0036). */
  searching: boolean
}

const fmt = (n: number) => n.toLocaleString('en-AU')

/**
 * Totals for the WHOLE filtered result set, not the visible page (VER-323,
 * ADR 0036). One server-side aggregate (get_booking_tally) counted exactly as
 * the council invoice is. Counts only: no export, no resident details.
 */
export function BookingTallyPanel({
  clientId,
  statuses,
  areaIds,
  types,
  serviceIds,
  dateFrom,
  dateTo,
  searching,
}: BookingTallyPanelProps) {
  const supabase = createClient()

  const { data, isLoading } = useQuery({
    queryKey: ['booking-tally', clientId, statuses, areaIds, types, serviceIds, dateFrom, dateTo],
    enabled: !!clientId && !searching,
    queryFn: async (): Promise<Result<Tally>> => {
      const { data: raw, error } = await supabase.rpc('get_booking_tally', {
        p_client_id: clientId,
        ...(statuses.length ? { p_statuses: statuses } : {}),
        ...(areaIds.length ? { p_area_ids: areaIds } : {}),
        ...(types.length ? { p_types: types } : {}),
        ...(serviceIds.length ? { p_service_ids: serviceIds } : {}),
        ...(dateFrom ? { p_date_from: dateFrom } : {}),
        ...(dateTo ? { p_date_to: dateTo } : {}),
      })
      if (error) return { ok: false, error: error.message }
      const parsed = parseTally(raw)
      return parsed.ok ? { ok: true, data: buildTally(parsed.data) } : parsed
    },
  })

  if (!clientId) return null

  return (
    <section aria-labelledby="booking-totals-heading" className="mt-6 rounded-xl bg-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="booking-totals-heading" className="font-[family-name:var(--font-heading)] text-sm font-semibold text-gray-900">
          Totals for these filters
        </h2>
        <p className="text-xs text-gray-500">
          Every matching booking, not just this page. Units are what the invoice counts, by collection date.
        </p>
      </div>

      {searching ? (
        <p className="text-sm text-gray-500">
          Totals are hidden while you search. Clear the search box to total these filters.
        </p>
      ) : isLoading || !data ? (
        <div className="space-y-2" aria-label="Loading totals">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : !data.ok ? (
        <p role="alert" className="text-sm text-status-error">
          Totals couldn&apos;t load: {data.error}
        </p>
      ) : data.data.total.bookings === 0 && data.data.total.includedTotal === 0 ? (
        <p className="text-sm text-gray-500">No bookings match these filters.</p>
      ) : (
        <TallyTables tally={data.data} />
      )}
    </section>
  )
}

function TallyTables({ tally }: { tally: Tally }) {
  const { columns } = tally
  return (
    <>
      <OutcomeTable
        caption="Included (council)"
        tally={tally}
        cells={(r) => r.included}
        total={(r) => r.includedTotal}
        showBookings
        keepRow={() => true}
      />

      {tally.hasExtras && (
        <OutcomeTable
          caption="Extras (paid by residents)"
          tally={tally}
          cells={(r) => r.extras}
          total={(r) => r.extrasTotal}
          showBookings={false}
          keepRow={(r) => r.extrasTotal > 0}
        />
      )}

      {tally.hasCrewMattresses && columns.includes('Mattress') && (
        <p className="mt-3 text-xs text-gray-500">
          Mattress is the crew&apos;s count at closeout, as on the invoice, so it follows each stop&apos;s own outcome and date.
        </p>
      )}
    </>
  )
}

interface OutcomeTableProps {
  caption: string
  tally: Tally
  cells: (row: TallyRow) => Record<string, number>
  total: (row: TallyRow) => number
  showBookings: boolean
  /** Which outcome rows to list (subtotal and total rows always show). */
  keepRow: (row: TallyRow) => boolean
}

function OutcomeTable({ caption, tally, cells, total, showBookings, keepRow }: OutcomeTableProps) {
  const { columns } = tally

  const renderRow = (
    row: TallyRow,
    opts: { label: React.ReactNode; emphasis?: 'subtotal' | 'total'; key: string },
  ) => (
    <tr
      key={opts.key}
      className={cn(
        'border-b border-gray-100 last:border-b-0',
        opts.emphasis && 'bg-gray-50 font-semibold text-gray-900',
        opts.emphasis === 'total' && 'border-t-2 border-t-gray-200'
      )}
    >
      <th scope="row" className={cn('px-4 py-2 text-left text-sm', opts.emphasis ? 'font-semibold' : 'font-normal text-gray-700')}>
        {opts.label}
      </th>
      {showBookings && <td className="px-4 py-2 text-right text-sm">{fmt(row.bookings)}</td>}
      {columns.map((c) => {
        const n = cells(row)[c] ?? 0
        return (
          <td key={c} className={cn('px-4 py-2 text-right text-sm', n === 0 && !opts.emphasis && 'text-gray-300')}>
            {fmt(n)}
          </td>
        )
      })}
      <td className="px-4 py-2 text-right text-sm font-semibold">{fmt(total(row))}</td>
    </tr>
  )

  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full border-collapse tabular-nums">
        <caption className="pb-2 text-left text-caption font-semibold uppercase tracking-wide text-gray-500">
          {caption}
        </caption>
        <thead>
          <tr>
            <Th>Outcome</Th>
            {showBookings && <Th className="text-right">Bookings</Th>}
            {columns.map((c) => (
              <Th key={c} className="text-right">{c}</Th>
            ))}
            <Th className="text-right">Units</Th>
          </tr>
        </thead>
        <tbody>
          {tally.billable.filter(keepRow).map((r) => renderRow(r, { key: r.status, label: r.status }))}
          {renderRow(tally.billableTotal, { key: 'billable', label: 'Billable (attended)', emphasis: 'subtotal' })}
          {tally.other.filter(keepRow).map((r) =>
            renderRow(r, {
              key: r.status,
              label: (
                <>
                  {r.status}
                  {r.reason && <span className="ml-2 text-xs text-gray-400">{r.reason}</span>}
                </>
              ),
            })
          )}
          {renderRow(tally.total, { key: 'total', label: 'All matching', emphasis: 'total' })}
        </tbody>
      </table>
    </div>
  )
}
