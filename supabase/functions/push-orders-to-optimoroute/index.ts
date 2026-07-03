import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import { awstDateFromUtc } from '../_shared/schedule-transition.ts'
import {
  buildOrderNo,
  buildOrderNotes,
  buildServicesSummary,
  groupItemsByStream,
  STOP_DURATION_MINUTES,
  STREAM_PRIORITY,
  vehicleFeaturesForStream,
  wasteLocationOrNull,
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
 * Diff-based and idempotent (safe to re-run any time):
 *  1. Generation/reconciliation — desired stops are computed from live
 *     (Confirmed/Scheduled) bookings on locked upcoming dates, one per waste
 *     stream, then diffed against existing rows:
 *       · missing            → insert
 *       · Pending + changed  → refresh payload (date/address/services) and
 *                              reset pushed_at so the change re-pushes
 *       · Cancelled + stream reappeared → revive to Pending (state-machine
 *                              carve-out; otherwise UNIQUE(booking_id,stream)
 *                              would block the stream forever)
 *       · Pending + stream gone, or booking no longer live → Cancelled
 *     Late stragglers (admin rebooks, EF outages, deploy-day backfill) heal
 *     on the next tick.
 *  2. Push — Pending stops with pushed_at IS NULL are pushed (SYNC). Already
 *     -pushed unchanged stops are NOT re-pushed: a SYNC replace could
 *     unschedule an order ops already planned, so re-pushes happen only when
 *     pass 1 detected a real change. Per-order failures stamp
 *     last_push_error and the run returns HTTP 500 (pg_cron only sees the
 *     HTTP status).
 */

interface BookingItemRow extends StopItem {
  collection_date_id: string
}

interface BookingRow {
  id: string
  ref: string
  client_id: string
  latitude: number | null
  longitude: number | null
  geo_address: string | null
  location: string | null
  notes: string | null
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

interface ExistingStopRow {
  id: string
  booking_id: string
  stream: WasteStream
  status: string
  collection_date_id: string
  address: string | null
  latitude: number | string | null
  longitude: number | string | null
  services_summary: ServiceSummaryEntry[]
  waste_location: string | null
  driver_notes: string | null
}

interface PendingStopRow {
  id: string
  stream: WasteStream
  external_order_ref: string
  address: string | null
  latitude: number | string | null
  longitude: number | string | null
  services_summary: ServiceSummaryEntry[]
  waste_location: string | null
  driver_notes: string | null
  collection_date: { date: string }
}

interface DesiredStop {
  booking_id: string
  client_id: string
  stream: WasteStream
  collection_date_id: string
  address: string | null
  latitude: number | null
  longitude: number | null
  services_summary: ServiceSummaryEntry[]
  waste_location: string | null
  driver_notes: string | null
  external_order_ref: string
}

const PAGE_SIZE = 1000

/**
 * Pages past PostgREST's max_rows (1000 in config.toml) — a single .select()
 * silently truncates at the cap, which at multi-tenant scale would skip
 * stops with no error anywhere.
 */
async function fetchAll<T>(
  buildQuery: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    const page = (data ?? []) as T[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
  }
}

function num(value: number | string | null): number | null {
  return value === null ? null : Number(value)
}

function payloadDiffers(existing: ExistingStopRow, desired: DesiredStop): boolean {
  return (
    existing.collection_date_id !== desired.collection_date_id ||
    (existing.address ?? null) !== (desired.address ?? null) ||
    num(existing.latitude) !== desired.latitude ||
    num(existing.longitude) !== desired.longitude ||
    (existing.waste_location ?? null) !== (desired.waste_location ?? null) ||
    (existing.driver_notes ?? null) !== (desired.driver_notes ?? null) ||
    JSON.stringify(existing.services_summary ?? []) !== JSON.stringify(desired.services_summary)
  )
}

serve(async (_req) => {
  const supabase: SupabaseClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const today = awstDateFromUtc(new Date())
  const results = {
    today_awst: today,
    locked_dates: 0,
    stops_created: 0,
    stops_refreshed: 0,
    stops_revived: 0,
    stops_cancelled: 0,
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
      // --- Pass 1: diff desired stops against existing rows --------------
      const bookingRows = await fetchAll<BookingRow>(
        (from, to) =>
          supabase
            .from('booking')
            .select(
              `id, ref, client_id, latitude, longitude, geo_address, location, notes,
               eligible_properties:property_id(formatted_address, address, latitude, longitude),
               booking_item!inner(no_services, collection_date_id, service(name, waste_stream))`,
            )
            .in('status', ['Confirmed', 'Scheduled'])
            .in('booking_item.collection_date_id', lockedDateIds)
            .order('id')
            .range(from, to),
        'booking fetch',
      )

      // desired: bookingId → stream → payload
      const desired = new Map<string, Map<WasteStream, DesiredStop>>()
      for (const booking of bookingRows) {
        const items = booking.booking_item.filter(
          (i): i is BookingItemRow => i.service !== null,
        )
        const property = booking.eligible_properties
        const byStream = new Map<WasteStream, DesiredStop>()
        for (const [stream, streamItems] of groupItemsByStream(items)) {
          byStream.set(stream, {
            booking_id: booking.id,
            client_id: booking.client_id,
            stream,
            // Items in one stream share a collection date in practice; the
            // first item's date is the stop's date.
            collection_date_id: streamItems[0]!.collection_date_id,
            address:
              property?.formatted_address ??
              property?.address ??
              booking.geo_address ??
              booking.location,
            latitude: num(booking.latitude ?? property?.latitude ?? null),
            longitude: num(booking.longitude ?? property?.longitude ?? null),
            services_summary: buildServicesSummary(streamItems),
            waste_location: wasteLocationOrNull(booking.location),
            driver_notes: booking.notes,
            external_order_ref: buildOrderNo(booking.ref, stream),
          })
        }
        desired.set(booking.id, byStream)
      }

      const existing = await fetchAll<ExistingStopRow>(
        (from, to) =>
          supabase
            .from('collection_stop')
            .select(
              'id, booking_id, stream, status, collection_date_id, address, latitude, longitude, services_summary, waste_location, driver_notes',
            )
            .in('collection_date_id', lockedDateIds)
            .order('id')
            .range(from, to),
        'existing stops fetch',
      )

      const existingByKey = new Map<string, ExistingStopRow>()
      for (const stop of existing) {
        existingByKey.set(`${stop.booking_id}:${stop.stream}`, stop)
      }

      const inserts: DesiredStop[] = []
      const refreshIds: Array<{ id: string; payload: DesiredStop }> = []
      const reviveIds: Array<{ id: string; payload: DesiredStop }> = []
      const cancelIds: string[] = []

      for (const byStream of desired.values()) {
        for (const want of byStream.values()) {
          const have = existingByKey.get(`${want.booking_id}:${want.stream}`)
          if (!have) {
            inserts.push(want)
          } else if (have.status === 'Pending' && payloadDiffers(have, want)) {
            refreshIds.push({ id: have.id, payload: want })
          } else if (have.status === 'Cancelled') {
            // Stream reappeared after a post-push amendment — revive, or the
            // UNIQUE(booking_id, stream) row blocks the stream forever and
            // the booking rolls up Completed without it ever being collected.
            reviveIds.push({ id: have.id, payload: want })
          }
        }
      }

      // Orphans among existing Pending stops: stream gone from a live
      // booking, or the booking is no longer live at all. The booking-status
      // sync trigger cancels stops when a booking is cancelled — but only
      // stops that existed when it fired; a booking cancelled between our
      // fetch and a previous run's insert leaves a Pending stop the trigger
      // never saw, so booking status is re-checked here every run.
      const unknownBookingIds = [
        ...new Set(
          existing
            .filter((s) => s.status === 'Pending' && !desired.has(s.booking_id))
            .map((s) => s.booking_id),
        ),
      ]
      const liveUnknown = new Set<string>()
      if (unknownBookingIds.length > 0) {
        const statuses = await fetchAll<{ id: string; status: string }>(
          (from, to) =>
            supabase
              .from('booking')
              .select('id, status')
              .in('id', unknownBookingIds)
              .order('id')
              .range(from, to),
          'orphan booking status fetch',
        )
        for (const b of statuses) {
          if (b.status === 'Confirmed' || b.status === 'Scheduled') liveUnknown.add(b.id)
        }
      }

      for (const stop of existing) {
        if (stop.status !== 'Pending') continue
        const byStream = desired.get(stop.booking_id)
        if (byStream) {
          if (!byStream.has(stop.stream)) cancelIds.push(stop.id) // stream gone
        } else if (!liveUnknown.has(stop.booking_id)) {
          cancelIds.push(stop.id) // booking cancelled/terminal
        }
        // booking live but absent from desired with the stream present can't
        // happen — desired is keyed by the same live-booking query.
      }

      if (inserts.length > 0) {
        // ignoreDuplicates tolerates a concurrent manual run racing this one.
        const { data: insertedRows, error: insertError } = await supabase
          .from('collection_stop')
          .upsert(inserts as unknown as Record<string, unknown>[], {
            onConflict: 'booking_id,stream',
            ignoreDuplicates: true,
          })
          .select('id')
        if (insertError) throw new Error(`collection_stop insert: ${insertError.message}`)
        results.stops_created = (insertedRows ?? []).length
      }

      for (const { id, payload } of refreshIds) {
        const { error } = await supabase
          .from('collection_stop')
          .update({
            collection_date_id: payload.collection_date_id,
            address: payload.address,
            latitude: payload.latitude,
            longitude: payload.longitude,
            services_summary: payload.services_summary,
            waste_location: payload.waste_location,
            driver_notes: payload.driver_notes,
            pushed_at: null, // changed payload → re-push in pass 2
            external_deleted_at: null,
          })
          .eq('id', id)
          .eq('status', 'Pending')
        if (error) {
          results.failed++
          console.error(`Stop refresh failed for ${id}: ${error.message}`)
        } else {
          results.stops_refreshed++
        }
      }

      for (const { id, payload } of reviveIds) {
        const { error } = await supabase
          .from('collection_stop')
          .update({
            status: 'Pending',
            cancelled_at: null,
            collection_date_id: payload.collection_date_id,
            address: payload.address,
            latitude: payload.latitude,
            longitude: payload.longitude,
            services_summary: payload.services_summary,
            waste_location: payload.waste_location,
            driver_notes: payload.driver_notes,
            pushed_at: null,
            external_deleted_at: null,
          })
          .eq('id', id)
          .eq('status', 'Cancelled')
        if (error) {
          results.failed++
          console.error(`Stop revival failed for ${id}: ${error.message}`)
        } else {
          results.stops_revived++
        }
      }

      if (cancelIds.length > 0) {
        console.warn(`Cancelling ${cancelIds.length} orphaned stops`, cancelIds)
        // .eq status guard: a stop terminalised since our fetch would trip
        // the state-machine trigger and abort the whole batch otherwise.
        const { data: cancelled, error: cancelError } = await supabase
          .from('collection_stop')
          .update({ status: 'Cancelled', cancelled_at: new Date().toISOString() })
          .in('id', cancelIds)
          .eq('status', 'Pending')
          .select('id')
        if (cancelError) throw new Error(`orphan cancel: ${cancelError.message}`)
        results.stops_cancelled = (cancelled ?? []).length
      }
    }

    // --- Pass 2: push Pending stops not yet (or re-)pushed ---------------
    // pushed_at IS NULL only — never blind-re-SYNC already-planned orders
    // (a SYNC replace may unschedule them in the routing engine; changed
    // stops re-enter this set via the pass-1 pushed_at reset).
    const stops = await fetchAll<PendingStopRow>(
      (from, to) =>
        supabase
          .from('collection_stop')
          .select(
            `id, stream, external_order_ref, address, latitude, longitude,
             services_summary, waste_location, driver_notes, collection_date!inner(date)`,
          )
          .eq('status', 'Pending')
          .is('pushed_at', null)
          .gte('collection_date.date', today)
          .order('id')
          .range(from, to),
      'pending stops fetch',
    )

    if (stops.length > 0) {
      const orders: OrOrderInput[] = stops.map((stop) => ({
        orderNo: stop.external_order_ref,
        date: stop.collection_date.date,
        duration: STOP_DURATION_MINUTES,
        priority: STREAM_PRIORITY[stop.stream],
        vehicleFeatures: vehicleFeaturesForStream(stop.stream),
        notes: buildOrderNotes(stop.services_summary ?? [], stop.waste_location, stop.driver_notes),
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
        // external_deleted_at reset: if the hourly sweep deleted this orderNo
        // mid-push (booking cancelled while we were in flight), clearing the
        // marker lets the next sweep see the recreated order and re-delete it.
        const { error: stampError } = await supabase
          .from('collection_stop')
          .update({
            pushed_at: new Date().toISOString(),
            last_push_error: null,
            external_deleted_at: null,
          })
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
