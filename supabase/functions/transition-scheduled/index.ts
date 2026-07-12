import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from '../_shared/database.types.ts'
import {
  awstDateFromUtc,
  filterBookingsReadyToSchedule,
  type BookingWithItemDates,
} from '../_shared/schedule-transition.ts'

/**
 * transition-scheduled cron Edge Function
 *
 * Fires daily at 15:25 AWST (07:25 UTC) via pg_cron. Service role only —
 * the DB trigger enforce_booking_state_transition is the authoritative guard
 * for this transition.
 *
 * Transitions Confirmed bookings to Scheduled when the earliest collection
 * date on the booking is tomorrow (AWST). The cancellation cutoff
 * (15:30 AWST the day prior) is about to pass, so the booking is locked in.
 *
 * Note on timing: "tomorrow" is computed from wall-clock at invocation. A
 * scheduled fire at 07:25 UTC resolves correctly; a late manual invocation
 * may target a different date. pg_cron does not retry missed runs.
 */

serve(async (_req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const supabase = createClient<Database>(supabaseUrl, serviceRoleKey)

  const tomorrow = awstDateFromUtc(new Date(Date.now() + 24 * 60 * 60 * 1000))

  const results = {
    tomorrow_awst: tomorrow,
    transitioned: 0,
    failed: 0,
    skipped_no_date: 0,
  }

  try {
    const { data: bookings, error: fetchError } = await supabase
      .from('booking')
      .select('id, booking_item(collection_date(date))')
      .eq('status', 'Confirmed')

    if (fetchError) {
      console.error('Booking fetch error:', fetchError.message)
      return new Response(
        JSON.stringify({ ok: false, error: fetchError.message }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const bookingRows = (bookings ?? []) as BookingWithItemDates[]

    // Data-integrity check: a Confirmed booking with no collection_date is an
    // invariant violation (how did it confirm?). Log loudly so it surfaces.
    for (const booking of bookingRows) {
      const hasDate = booking.booking_item.some((item) => Boolean(item.collection_date?.date))
      if (!hasDate) {
        results.skipped_no_date++
        console.warn(`Confirmed booking ${booking.id} has no collection_date — skipping`)
      }
    }

    const candidateIds = filterBookingsReadyToSchedule(bookingRows, tomorrow)

    for (const id of candidateIds) {
      const { error: updateError } = await supabase
        .from('booking')
        .update({ status: 'Scheduled' })
        .eq('id', id)
        .eq('status', 'Confirmed')

      if (updateError) {
        results.failed++
        console.error(`Transition failed for ${id}: ${updateError.message}`)
      } else {
        results.transitioned++
      }
    }

    console.log(JSON.stringify({ event: 'transition_scheduled', ...results }))

    // Return 500 on any update failure so pg_cron logs a non-success HTTP
    // status — otherwise silent partial failures look fine to monitoring.
    const status = results.failed > 0 ? 500 : 200
    const ok = results.failed === 0
    return new Response(JSON.stringify({ ok, ...results }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('transition-scheduled error:', err)
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
})
