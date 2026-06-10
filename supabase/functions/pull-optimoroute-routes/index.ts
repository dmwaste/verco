import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import { addOneDay, awstDateFromUtc } from '../_shared/schedule-transition.ts'
import { getRoutes, getRoutingApiKey, type OrRoute } from '../_shared/optimoroute.ts'

/**
 * pull-optimoroute-routes Edge Function
 *
 * Two callers (dual auth per CLAUDE.md §21):
 *  - pg_cron every 4h (anon routing bearer — no user) — scheduled pulls
 *  - the admin "Refresh routes" server action (user JWT) — right after ops
 *    finish planning. Requires contractor-admin/contractor-staff.
 * Privileged work always runs on the env service-role client.
 *
 * For each date in today..today+3 AWST that has stops: fetch planned routes,
 * stamp driver/sequence/ETA onto Pending stops by orderNo (skipping
 * depot/break entries, which have no orderNo), null-out stops that fell out
 * of the plan, and upsert per-(driver, date) run metadata (start/finish
 * times + depot labels) for the run-sheet header.
 *
 * Pending-only stamping: terminal stops keep the sequence they were worked
 * under. Per-stop updates are sequential row-by-row — bounded by ~6 routes ×
 * ~80 stops, fine for a cron.
 */

const PULL_WINDOW_DAYS = 3

serve(async (req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  // --- Dual auth -------------------------------------------------------
  // A real user JWT must belong to contractor staff; the cron's anon
  // routing bearer resolves to no user and passes as the scheduled path.
  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (bearer) {
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    })
    const {
      data: { user },
    } = await callerClient.auth.getUser()
    if (user) {
      const { data: role, error: roleError } = await callerClient.rpc('current_user_role')
      if (roleError || !['contractor-admin', 'contractor-staff'].includes(role ?? '')) {
        return new Response(
          JSON.stringify({ ok: false, error: 'Insufficient permissions to refresh routes.' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        )
      }
    }
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const today = awstDateFromUtc(new Date())
  let windowEnd = today
  for (let i = 0; i < PULL_WINDOW_DAYS; i++) windowEnd = addOneDay(windowEnd)

  const results = {
    today_awst: today,
    dates_checked: 0,
    routes_seen: 0,
    stops_stamped: 0,
    stops_unplanned: 0,
    run_meta_upserts: 0,
    failed: 0,
  }

  try {
    const apiKey = getRoutingApiKey()

    // Dates in the window that actually have stops.
    const { data: stopDates, error: datesError } = await supabase
      .from('collection_stop')
      .select('collection_date!inner(date)')
      .gte('collection_date.date', today)
      .lte('collection_date.date', windowEnd)
    if (datesError) throw new Error(`stop dates fetch: ${datesError.message}`)

    const dates = [
      ...new Set(
        ((stopDates ?? []) as unknown as Array<{ collection_date: { date: string } }>).map(
          (s) => s.collection_date.date,
        ),
      ),
    ].sort()
    results.dates_checked = dates.length

    for (const date of dates) {
      const routes: OrRoute[] = await getRoutes(apiKey, date)
      results.routes_seen += routes.length

      const plannedRefs = new Set<string>()

      for (const route of routes) {
        const orderStops = route.stops.filter((s) => s.orderNo)
        const depotStops = route.stops.filter((s) => !s.orderNo)

        for (const stop of orderStops) {
          plannedRefs.add(stop.orderNo!)
          const { error: stampError } = await supabase
            .from('collection_stop')
            .update({
              driver_serial: route.driverSerial,
              driver_name: route.driverName,
              stop_sequence: stop.stopNumber,
              scheduled_at: stop.scheduledAt ?? null,
              routes_pulled_at: new Date().toISOString(),
            })
            .eq('external_order_ref', stop.orderNo!)
            .eq('status', 'Pending')
          if (stampError) {
            results.failed++
            console.error(`Stamp failed for ${stop.orderNo}: ${stampError.message}`)
          } else {
            results.stops_stamped++
          }
        }

        // Run-sheet header metadata: route start/finish + depot labels.
        const times = route.stops
          .map((s) => s.scheduledAt)
          .filter((t): t is string => Boolean(t))
          .sort()
        const { error: metaError } = await supabase.from('collection_run_meta').upsert(
          {
            driver_serial: route.driverSerial,
            date,
            driver_name: route.driverName,
            start_time: times[0] ?? null,
            finish_time: times[times.length - 1] ?? null,
            depot_labels: depotStops
              .map((s) => s.locationName ?? s.address)
              .filter((label): label is string => Boolean(label)),
            routes_pulled_at: new Date().toISOString(),
          },
          { onConflict: 'driver_serial,date' },
        )
        if (metaError) {
          results.failed++
          console.error(
            `Run meta upsert failed for ${route.driverSerial}/${date}: ${metaError.message}`,
          )
        } else {
          results.run_meta_upserts++
        }
      }

      // Stops that fell out of the plan (ops re-planned without them) go
      // back to unsequenced so the run sheet shows them as unplanned.
      const { data: unplanned, error: unplannedError } = await supabase
        .from('collection_stop')
        .select('id, external_order_ref, collection_date!inner(date)')
        .eq('status', 'Pending')
        .eq('collection_date.date', date)
        .not('driver_serial', 'is', null)
      if (unplannedError) {
        throw new Error(`unplanned fetch (${date}): ${unplannedError.message}`)
      }

      const fellOut = ((unplanned ?? []) as Array<{ id: string; external_order_ref: string }>)
        .filter((s) => !plannedRefs.has(s.external_order_ref))
        .map((s) => s.id)

      if (fellOut.length > 0) {
        const { error: clearError } = await supabase
          .from('collection_stop')
          .update({
            driver_serial: null,
            driver_name: null,
            stop_sequence: null,
            scheduled_at: null,
            routes_pulled_at: new Date().toISOString(),
          })
          .in('id', fellOut)
        if (clearError) throw new Error(`unplanned clear (${date}): ${clearError.message}`)
        results.stops_unplanned += fellOut.length
      }
    }

    console.log(JSON.stringify({ event: 'pull_optimoroute_routes', ...results }))

    const status = results.failed > 0 ? 500 : 200
    return new Response(JSON.stringify({ ok: results.failed === 0, ...results }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('pull-optimoroute-routes error:', err)
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
})
