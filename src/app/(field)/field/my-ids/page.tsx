import Link from 'next/link'
import { redirect } from 'next/navigation'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/server'
import { BookingStatusBadge } from '@/components/booking/booking-status-badge'
import type { Database } from '@/lib/supabase/types'

type BookingStatus = Database['public']['Enums']['booking_status']

interface IdBooking {
  id: string
  ref: string
  status: BookingStatus
  geo_address: string | null
  id_waste_types: string[]
  id_volume: string | null
  created_at: string
  booking_item: Array<{ collection_date: { date: string } }>
}

/**
 * "My IDs" — illegal-dumping bookings the signed-in ranger raised
 * (booking.created_by, stamped by create_id_booking_with_capacity_check).
 * Rangers raise IDs; crews collect them — this is the ranger's status view.
 */
export default async function MyIdsPage() {
  const supabase = await createClient()

  const { data: role } = await supabase.rpc('current_user_role')
  if (role !== 'ranger') {
    redirect('/field')
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    redirect('/auth')
  }

  const { data: bookings } = await supabase
    .from('booking')
    .select(
      `id, ref, status, geo_address, id_waste_types, id_volume, created_at,
       booking_item(collection_date!inner(date))`,
    )
    .eq('created_by', user.id)
    .eq('type', 'Illegal Dumping')
    .order('created_at', { ascending: false })
    .limit(100)

  const ids = (bookings ?? []) as unknown as IdBooking[]

  return (
    <div className="flex flex-col gap-3 px-5 pt-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-lg font-bold text-[var(--brand)]">
            My IDs
          </h1>
          <p className="mt-0.5 text-body-sm text-gray-500">
            Illegal-dumping collections you&apos;ve raised
          </p>
        </div>
        <span className="rounded-full bg-[#E8EEF2] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--brand)]">
          {ids.length}
        </span>
      </div>

      {ids.map((b) => {
        const date = b.booking_item.map((i) => i.collection_date.date).sort()[0] ?? null
        return (
          <Link
            key={b.id}
            href={`/field/booking/${b.ref}`}
            className="flex flex-col gap-2 rounded-xl bg-white p-3.5 shadow-sm active:bg-gray-50"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-[family-name:var(--font-heading)] text-xs font-semibold text-[#8FA5B8]">
                  {b.ref}
                </div>
                <div className="truncate text-sm font-semibold text-[var(--brand)]">
                  {b.geo_address ?? 'No address recorded'}
                </div>
                {date && (
                  <div className="text-xs text-gray-500">
                    Collection {format(new Date(`${date}T00:00:00`), 'EEE d MMM')}
                  </div>
                )}
              </div>
              <BookingStatusBadge status={b.status} />
            </div>
            {(b.id_waste_types.length > 0 || b.id_volume) && (
              <div className="flex flex-wrap gap-1.5">
                {b.id_waste_types.map((w) => (
                  <span
                    key={w}
                    className="inline-flex rounded-full bg-[#E8EEF2] px-2.5 py-0.5 text-[11px] font-medium text-[var(--brand)]"
                  >
                    {w}
                  </span>
                ))}
                {b.id_volume && (
                  <span className="inline-flex rounded-full bg-[#FFF3EA] px-2.5 py-0.5 text-[11px] font-medium text-[#8B4000]">
                    {b.id_volume}
                  </span>
                )}
              </div>
            )}
          </Link>
        )
      })}

      {ids.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-xl bg-white p-8 text-center shadow-sm">
          <span className="text-sm font-semibold text-[var(--brand)]">
            No IDs raised yet
          </span>
          <span className="text-xs text-gray-500">
            IDs you raise appear here with their collection status.
          </span>
          <Link
            href="/field/illegal-dumping/new"
            className="mt-1 flex min-h-[44px] items-center rounded-lg bg-[var(--brand)] px-5 text-xs font-semibold"
            style={{ color: 'var(--brand-foreground, #FFFFFF)' }}
          >
            Raise an ID
          </Link>
        </div>
      )}
    </div>
  )
}
