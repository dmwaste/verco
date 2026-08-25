import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { cronHandler } from '../_shared/cron-handler.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from '../_shared/database.types.ts'
import { awstDateFromUtc, fetchAllConfirmedBookings } from '../_shared/schedule-transition.ts'

/**
 * send-collection-reminders cron Edge Function
 *
 * Fires daily at 09:00 AWST (01:00 UTC) via pg_cron. Service role only.
 *
 * For each tenant with `client.sms_reminder_days_before` NOT NULL, finds
 * Confirmed bookings whose earliest `collection_date` is exactly
 * `today + sms_reminder_days_before` (AWST). Invokes `send-notification`
 * with `{type:'collection_reminder', booking_id}` for each.
 *
 * Idempotency lives in `send-notification` itself — the per-channel
 * `(booking_id, type, channel)` log key blocks duplicate sends on re-runs
 * within the same day or across days.
 *
 * Tenants with `sms_reminder_days_before = NULL` opt out entirely (no email
 * reminder either — the schema field controls the whole reminder, not just
 * the SMS channel; the name is historical).
 *
 * Returns HTTP 500 if any per-booking invocation fails, so pg_cron logs a
 * non-success status. The dispatcher is fire-and-forget at the EF level
 * (failures return 200 with `{ok:false}`), so this cron's HTTP-status check
 * captures network-level failures specifically.
 */

interface BookingRow {
  id: string
  client: { id: string; sms_reminder_days_before: number | null } | { id: string; sms_reminder_days_before: number | null }[] | null
  booking_item: Array<{ collection_date: { date: string } | { date: string }[] | null }>
}

function pickOne<T>(v: T | T[] | null): T | null {
  if (v === null) return null
  return Array.isArray(v) ? (v[0] ?? null) : v
}

function addDays(yyyymmdd: string, n: number): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function earliestCollectionDate(booking: BookingRow): string | null {
  const dates: string[] = []
  for (const item of booking.booking_item ?? []) {
    const cd = pickOne(item.collection_date)
    if (cd?.date) dates.push(cd.date)
  }
  if (dates.length === 0) return null
  return dates.sort()[0] ?? null
}

serve(cronHandler('send-collection-reminders', async (_req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient<Database>(supabaseUrl, serviceRoleKey)

  const today = awstDateFromUtc(new Date())

  const results = {
    today_awst: today,
    fetched: 0,
    candidates: 0,
    invoked: 0,
    failed: 0,
    skipped_no_config: 0,
    skipped_no_date: 0,
    skipped_wrong_date: 0,
  }

  try {
    // Paged, stably ordered. A single unpaginated fetch is silently truncated
    // at db-max-rows (1000) once the Confirmed set grows past it, which would
    // drop reminders for every booking beyond the cap without any error.
    const fetched = await fetchAllConfirmedBookings<BookingRow>(async (from, to) => {
      const { data, error } = await supabase
        .from('booking')
        .select(`
          id,
          client:client_id (id, sms_reminder_days_before),
          booking_item (collection_date (date))
        `)
        .eq('status', 'Confirmed')
        .order('id', { ascending: true })
        .range(from, to)

      if (error) return { rows: [], error: error.message }
      return { rows: (data ?? []) as BookingRow[] }
    })

    if (!fetched.ok) {
      console.error('Booking fetch error:', fetched.error)
      return new Response(
        JSON.stringify({ ok: false, error: fetched.error }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const rows = fetched.rows
    results.fetched = rows.length
    const candidates: string[] = []

    for (const booking of rows) {
      const client = pickOne(booking.client)
      const days = client?.sms_reminder_days_before
      if (days === null || days === undefined) {
        results.skipped_no_config++
        continue
      }

      const earliest = earliestCollectionDate(booking)
      if (!earliest) {
        results.skipped_no_date++
        continue
      }

      const targetDate = addDays(today, days)
      if (earliest !== targetDate) {
        results.skipped_wrong_date++
        continue
      }

      candidates.push(booking.id)
    }

    results.candidates = candidates.length

    // Sequential invocation — bounded by the number of bookings whose
    // collection date is exactly `today + days_before`. Typical: tens per day
    // per tenant. Switch to parallel if real-world volume warrants it.
    for (const id of candidates) {
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/send-notification`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ type: 'collection_reminder', booking_id: id }),
        })
        if (!res.ok) {
          results.failed++
          const errBody = await res.text().catch(() => '<unreadable>')
          console.error(`send-notification HTTP ${res.status} for booking ${id}: ${errBody}`)
        } else {
          results.invoked++
        }
      } catch (err) {
        results.failed++
        console.error(`send-notification crashed for booking ${id}:`, err)
      }
    }

    console.log(JSON.stringify({ event: 'send_collection_reminders', ...results }))

    const status = results.failed > 0 ? 500 : 200
    return new Response(JSON.stringify({ ok: results.failed === 0, ...results }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('send-collection-reminders error:', err)
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
}))
