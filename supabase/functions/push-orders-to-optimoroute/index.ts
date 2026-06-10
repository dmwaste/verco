import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import { awstDateFromUtc } from '../_shared/schedule-transition.ts'
import {
  buildOrderNo,
  buildOrderNotes,
  buildServicesSummary,
  groupItemsByStream,
  STOP_DURATION_MINUTES,
  STREAM_PRIORITY,
  type ServiceSummaryEntry,
  type StopItem,
  type WasteStream,
} from '../_shared/stops.ts'
import { createOrUpdateOrders, getRoutingApiKey, type OrOrderInput } from '../_shared/optimoroute.ts'

/**
 * push-orders-to-optimoroute cron Edge Function
 *
 * Fires daily at 03:10 AWST (19:10 UTC), ~40 min after close-imminent-dates
 * hard-locks collection dates at T-3. Service role only.
 *
 * Three passes, all idempotent (safe to re-run any time):
 *  1. Stop generation — every Confirmed/Scheduled booking with items on a
 *     locked upcoming date gets one collection_stop per waste stream
 *     (ON CONFLICT (booking_id, stream) DO NOTHING). Self-healing: late
 *     stragglers (admin rebooks onto a near-term date, an EF outage on lock
 *     night, deploy-day backfill) are caught on the next tick.
 *  2. Reconciliation — Pending stops whose booking no longer has items in
 *     that stream (post-push amendment) are Cancelled; the cancellation
 *     sweep then deletes their routing-engine orders.
 *  3. Push — every Pending stop on a locked upcoming date is SYNCed to
 *     OptimoRoute (create-or-replace), so post-push quantity edits propagate
 *     on the nightly re-push. Per-order failures stamp last_push_error and
 *     the run returns HTTP 500 (pg_cron only sees the HTTP status).
 */

interface BookingRow {
  id: string
  ref: string
  client_id: string
  latitude: number | null
  longitude: number | null
  geo_address: string | null
  location: string | null
  eligible_properties: {
    formatted_address: string | null
    address: string | null
    latitude: number | null
    longitude: number | null
  } | null
  booking_item: Array<{
    no_services: number
    collection_date_id: string
    service: { name: string; waste_stream: WasteStream } | null
  }>
}

interface PendingStopRow {
  id: string
  booking_id: string
  stream: WasteStream
  external_order_ref: string
  address: string | null
  latitude: number | null
  longitude: number | null
  services_summary: ServiceSummaryEntry[]
  collection_date: { date: string }
}

serve(async (_req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const today = awstDateFromUtc(new Date())
  const results = {
    today_awst: today,
    locked_dates: 0,
    stops_created: 0,
    stops_reconciled_cancelled: 0,
    orders_pushed: 0,
    failed: 0,
  }

  try {
    const apiKey = getRoutingApiKey()

    // Locked upcoming dates (close-imminent-dates sets locked_closed at T-3).
    const { data: lockedDates, error: datesError } = await supabase
      .from('collection_date')
      .select('id, date')
      .eq('locked_closed', true)
      .gte('date', today)
    if (datesError) throw new Error(`collection_date fetch: ${datesError.message}`)

    const lockedDateIds = (lockedDates ?? []).map((d) => d.id)
    results.locked_dates = lockedDateIds.length

    if (lockedDateIds.length > 0) {
      // --- Pass 1: stop generation -------------------------------------
      const { data: bookings, error: bookingsError } = await supabase
        .from('booking')
        .select(
          `id, ref, client_id, latitude, longitude, geo_address, location,
           eligible_properties:property_id(formatted_address, address, latitude, longitude),
           booking_item!inner(no_services, collection_date_id, service(name, waste_stream))`,
        )
        .in('status', ['Confirmed', 'Scheduled'])
        .in('booking_item.collection_date_id', lockedDateIds)
      if (bookingsError) throw new Error(`booking fetch: ${bookingsError.message}`)

      const bookingRows = (bookings ?? []) as unknown as BookingRow[]
      const streamsByBooking = new Map<string, Set<WasteStream>>()
      const stopRows: Array<Record<string, unknown>> = []

      for (const booking of bookingRows) {
        const items = booking.booking_item.filter((i) => i.service !== null)
        const groups = groupItemsByStream(items as StopItem[])
        streamsByBooking.set(booking.id, new Set(groups.keys()))

        for (const [stream, streamItems] of groups) {
          const property = booking.eligible_properties
          // Items in one stream share a collection date in practice; the
          // first item's date is the stop's date.
          const dateId = (streamItems[0] as unknown as { collection_date_id: string })
            .collection_date_id
          stopRows.push({
            booking_id: booking.id,
            client_id: booking.client_id,
            stream,
            collection_date_id: dateId,
            address:
              property?.formatted_address ??
              property?.address ??
              booking.geo_address ??
              booking.location,
            latitude: booking.latitude ?? property?.latitude ?? null,
            longitude: booking.longitude ?? property?.longitude ?? null,
            services_summary: buildServicesSummary(streamItems),
            external_order_ref: buildOrderNo(booking.ref, stream),
          })
        }
      }

      if (stopRows.length > 0) {
        const { data: inserted, error: upsertError } = await supabase
          .from('collection_stop')
          .upsert(stopRows, { onConflict: 'booking_id,stream', ignoreDuplicates: true })
          .select('id')
        if (upsertError) throw new Error(`collection_stop upsert: ${upsertError.message}`)
        results.stops_created = (inserted ?? []).length
      }

      // --- Pass 2: reconcile stream-disappeared stops -------------------
      const { data: pendingForReconcile, error: reconcileFetchError } = await supabase
        .from('collection_stop')
        .select('id, booking_id, stream')
        .eq('status', 'Pending')
        .in('collection_date_id', lockedDateIds)
      if (reconcileFetchError) {
        throw new Error(`reconcile fetch: ${reconcileFetchError.message}`)
      }

      const orphanIds = (pendingForReconcile ?? [])
        .filter((s) => {
          const streams = streamsByBooking.get(s.booking_id)
          // Booking absent from the live set = not Confirmed/Scheduled any
          // more; the booking-status sync trigger owns those. Only cancel
          // stops whose booking is live but no longer has the stream.
          return streams !== undefined && !streams.has(s.stream as WasteStream)
        })
        .map((s) => s.id)

      if (orphanIds.length > 0) {
        console.warn(`Cancelling ${orphanIds.length} stream-disappeared stops`, orphanIds)
        const { error: cancelError } = await supabase
          .from('collection_stop')
          .update({ status: 'Cancelled', cancelled_at: new Date().toISOString() })
          .in('id', orphanIds)
        if (cancelError) throw new Error(`reconcile cancel: ${cancelError.message}`)
        results.stops_reconciled_cancelled = orphanIds.length
      }
    }

    // --- Pass 3: push all Pending stops on locked upcoming dates --------
    // SYNC is create-or-replace, so re-pushing already-pushed stops
    // propagates post-push item edits at the cost of idempotent no-ops.
    const { data: pendingStops, error: pendingError } = await supabase
      .from('collection_stop')
      .select(
        `id, booking_id, stream, external_order_ref, address, latitude, longitude,
         services_summary, collection_date!inner(date)`,
      )
      .eq('status', 'Pending')
      .gte('collection_date.date', today)
    if (pendingError) throw new Error(`pending stops fetch: ${pendingError.message}`)

    const stops = (pendingStops ?? []) as unknown as PendingStopRow[]

    if (stops.length > 0) {
      const orders: OrOrderInput[] = stops.map((stop) => ({
        orderNo: stop.external_order_ref,
        date: stop.collection_date.date,
        duration: STOP_DURATION_MINUTES,
        priority: STREAM_PRIORITY[stop.stream],
        notes: buildOrderNotes(stop.services_summary ?? []),
        location:
          stop.latitude !== null && stop.longitude !== null
            ? {
                latitude: Number(stop.latitude),
                longitude: Number(stop.longitude),
                locationName: stop.address ?? undefined,
              }
            : {
                address: stop.address ?? undefined,
                acceptPartialMatch: true,
              },
      }))

      const orderResults = await createOrUpdateOrders(apiKey, orders)

      const okIds: string[] = []
      for (let i = 0; i < stops.length; i++) {
        const result = orderResults[i]
        if (result?.success) {
          okIds.push(stops[i]!.id)
        } else {
          results.failed++
          const message = result?.error ?? 'no result returned'
          console.error(`Push failed for ${stops[i]!.external_order_ref}: ${message}`)
          await supabase
            .from('collection_stop')
            .update({ last_push_error: message })
            .eq('id', stops[i]!.id)
        }
      }

      if (okIds.length > 0) {
        const { error: stampError } = await supabase
          .from('collection_stop')
          .update({ pushed_at: new Date().toISOString(), last_push_error: null })
          .in('id', okIds)
        if (stampError) throw new Error(`pushed_at stamp: ${stampError.message}`)
        results.orders_pushed = okIds.length
      }
    }

    console.log(JSON.stringify({ event: 'push_orders_to_optimoroute', ...results }))

    // 500 on any per-order failure so pg_cron monitoring sees it.
    const status = results.failed > 0 ? 500 : 200
    return new Response(JSON.stringify({ ok: results.failed === 0, ...results }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('push-orders-to-optimoroute error:', err)
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
})
