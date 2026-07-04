import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import { addOneDay, awstDateFromUtc } from '../_shared/schedule-transition.ts'
import { getRoutes, getRoutingApiKey, type OrRoute } from '../_shared/optimoroute.ts'

/**
 * pull-optimoroute-routes Edge Function
 *
 * Two callers (dual auth per CLAUDE.md §21):
 *  - pg_cron every 4h — sends the public anon key as its routing bearer
 *  - the admin "Refresh routes" server action (user JWT) — requires
 *    contractor-admin/contractor-staff
 * Any other bearer (garbage, expired, non-staff user) is rejected; a missing
 * bearer is rejected outright. Privileged work runs on the env service-role
 * client.
 *
 * For each date in today..today+3 AWST: fetch planned routes, stamp
 * driver/sequence/ETA onto Pending stops by orderNo — only when values
 * actually changed (every 4h re-stamping unchanged rows would generate
 * thousands of pure-noise audit_log rows a day) — and upsert per-(driver,
 * date) run metadata. Stops that fell out of the plan are cleared per date
 * using the WHOLE window's planned refs, so an order ops moved to a
 * different date in the OR web UI keeps its stamp instead of being cleared
 * by its home date's sweep. Dates whose fetch failed are skipped for
 * clearing (their refs are unknown) and retried next tick.
 *
 * Pending-only stamping: terminal stops keep the sequence they were worked
 * under.
 */

const PULL_WINDOW_DAYS = 3

interface WindowStop {
  id: string
  external_order_ref: string
  driver_serial: string | null
  driver_name: string | null
  stop_sequence: number | null
  scheduled_at: string | null
  collection_date: { date: string }
}

serve(async (req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  // --- Dual auth -------------------------------------------------------
  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!bearer) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Authorization bearer.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (bearer !== anonKey) {
    // Not the cron's routing bearer — must be a valid contractor-staff JWT.
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    })
    const {
      data: { user },
    } = await callerClient.auth.getUser()
    if (!user) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid bearer token.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const { data: role, error: roleError } = await callerClient.rpc('current_user_role')
    if (roleError || !['contractor-admin', 'contractor-staff'].includes(role ?? '')) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Insufficient permissions to refresh routes.' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      )
    }
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const today = awstDateFromUtc(new Date())
  const windowDates: string[] = [today]
  for (let i = 0; i < PULL_WINDOW_DAYS; i++) {
    windowDates.push(addOneDay(windowDates[windowDates.length - 1]!))
  }

  const results = {
    today_awst: today,
    dates_checked: windowDates.length,
    dates_failed: 0,
    routes_seen: 0,
    stops_stamped: 0,
    stops_unplanned: 0,
    run_meta_upserts: 0,
    failed: 0,
  }

  try {
    const apiKey = getRoutingApiKey()

    // Current Pending stops across the window, keyed by orderNo — both the
    // stamp-only-on-change diff and the fell-out sweep work off this.
    const windowStops: WindowStop[] = []
    for (let from = 0; ; from += 1000) {
      const { data: page, error } = await supabase
        .from('collection_stop')
        .select(
          `id, external_order_ref, driver_serial, driver_name, stop_sequence, scheduled_at,
           collection_date!inner(date)`,
        )
        .eq('status', 'Pending')
        .gte('collection_date.date', windowDates[0]!)
        .lte('collection_date.date', windowDates[windowDates.length - 1]!)
        .order('id')
        .range(from, from + 999)
      if (error) throw new Error(`window stops fetch: ${error.message}`)
      windowStops.push(...((page ?? []) as unknown as WindowStop[]))
      if ((page ?? []).length < 1000) break
    }
    const stopByRef = new Map(windowStops.map((s) => [s.external_order_ref, s]))

    const plannedRefs = new Set<string>()
    const succeededDates: string[] = []

    for (const date of windowDates) {
      let routes: OrRoute[]
      try {
        routes = await getRoutes(apiKey, date)
      } catch (err) {
        // One bad date must not abort the rest of the window.
        results.dates_failed++
        results.failed++
        console.error(`getRoutes(${date}) failed:`, err instanceof Error ? err.message : err)
        continue
      }
      succeededDates.push(date)
      results.routes_seen += routes.length

      const driversSeen = new Set<string>()

      for (const route of routes) {
        // D&M's OptimoRoute drivers leave the "Serial No." field blank and
        // carry their code (KWN1 / VV3 / KWNA) in the driver name, so
        // get_routes returns driverSerial:''. driver_serial is the run key
        // everywhere (grouping, the run-sheet URL segment, run_meta, the field
        // picker) — an empty serial collapses every driver into one run — so
        // fall back to the name when the serial is blank.
        const serial = route.driverSerial || route.driverName
        driversSeen.add(serial)
        // Order stops carry an orderNo and no type; depot/break entries are
        // discriminated by the documented `type` field.
        const orderStops = route.stops.filter((s) => s.orderNo && !s.type)
        const depotStops = route.stops.filter((s) => s.type === 'depot')

        for (const stop of orderStops) {
          plannedRefs.add(stop.orderNo!)
          const current = stopByRef.get(stop.orderNo!)
          if (!current) continue // not ours / terminal — nothing to stamp
          const unchanged =
            current.driver_serial === serial &&
            current.driver_name === route.driverName &&
            current.stop_sequence === stop.stopNumber &&
            (current.scheduled_at ?? '').slice(0, 5) === (stop.scheduledAt ?? '')
          if (unchanged) continue

          const { error: stampError } = await supabase
            .from('collection_stop')
            .update({
              driver_serial: serial,
              driver_name: route.driverName,
              stop_sequence: stop.stopNumber,
              scheduled_at: stop.scheduledAt ?? null,
              routes_pulled_at: new Date().toISOString(),
            })
            .eq('id', current.id)
            .eq('status', 'Pending')
          if (stampError) {
            results.failed++
            console.error(`Stamp failed for ${stop.orderNo}: ${stampError.message}`)
          } else {
            results.stops_stamped++
          }
        }

        // Run-sheet header metadata: route start/finish + depot labels
        // (includeRouteStartEnd=true adds the route's start/end entries).
        const times = route.stops
          .map((s) => s.scheduledAt)
          .filter((t): t is string => Boolean(t))
          .sort()
        const { error: metaError } = await supabase.from('collection_run_meta').upsert(
          {
            driver_serial: serial,
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
            `Run meta upsert failed for ${serial}/${date}: ${metaError.message}`,
          )
        } else {
          results.run_meta_upserts++
        }
      }

      // Ghost run headers: a driver dropped from a re-plan would otherwise
      // keep a stale run_meta row for this date forever.
      const { error: ghostError } = driversSeen.size > 0
        ? await supabase
            .from('collection_run_meta')
            .delete()
            .eq('date', date)
            .not('driver_serial', 'in', `(${[...driversSeen].map((d) => `"${d}"`).join(',')})`)
        : await supabase.from('collection_run_meta').delete().eq('date', date)
      if (ghostError) {
        results.failed++
        console.error(`Run meta cleanup failed for ${date}: ${ghostError.message}`)
      }
    }

    // Fell-out-of-plan clearing — per succeeded date, against the WHOLE
    // window's planned refs (cross-date moves in OR keep their stamp).
    const succeeded = new Set(succeededDates)
    const fellOut = windowStops
      .filter(
        (s) =>
          s.driver_serial !== null &&
          succeeded.has(s.collection_date.date) &&
          !plannedRefs.has(s.external_order_ref),
      )
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
        .eq('status', 'Pending')
      if (clearError) throw new Error(`unplanned clear: ${clearError.message}`)
      results.stops_unplanned = fellOut.length
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
