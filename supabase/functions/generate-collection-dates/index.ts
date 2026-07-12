import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from '../_shared/database.types.ts'
import {
  planDates,
  windowFromToday,
  type ScheduleEntry,
} from '../_shared/collection-dates.ts'

/**
 * generate-collection-dates cron Edge Function
 *
 * Fires daily at 19:00 UTC (= 3am AWST next day) via pg_cron. Service role.
 *
 * For the next 16 weeks, generates:
 *   - collection_date rows for every area in collection_schedule
 *   - collection_date_pool rows for every pool in capacity_pool_schedule
 *
 * Idempotent: UNIQUE constraints on (area, date) and (pool, date) +
 * ON CONFLICT DO NOTHING means re-runs are safe. Schedule changes don't
 * retroactively alter existing future dates — ops can manually UPDATE
 * if needed.
 *
 * Public holidays (from public_holiday table) get rows created but flagged:
 *   - per-area: is_open=false, all capacity_limits=0
 *   - per-pool: bulk/anc/id _is_closed=true, all capacity_limits=0
 * Residents won't see them (date picker filters is_open=true). Admin can
 * still see them in the calendar with the holiday name for context.
 */

const HORIZON_WEEKS = 16

interface Counts {
  start_date: string
  end_date: string
  schedule_entries: number
  pool_schedule_entries: number
  holidays_in_window: number
  collection_dates_inserted: number
  collection_dates_skipped: number
  pool_dates_inserted: number
  pool_dates_skipped: number
  failed: number
  errors: string[]
}

serve(async (_req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient<Database>(supabaseUrl, serviceRoleKey)

  const today = new Date()
  const { start, end } = windowFromToday(today, HORIZON_WEEKS)

  const counts: Counts = {
    start_date: start.toISOString().slice(0, 10),
    end_date: end.toISOString().slice(0, 10),
    schedule_entries: 0,
    pool_schedule_entries: 0,
    holidays_in_window: 0,
    collection_dates_inserted: 0,
    collection_dates_skipped: 0,
    pool_dates_inserted: 0,
    pool_dates_skipped: 0,
    failed: 0,
    errors: [],
  }

  try {
    // 1. Load active schedules + holidays in parallel.
    const [scheduleResp, poolScheduleResp, holidayResp] = await Promise.all([
      supabase
        .from('collection_schedule')
        .select('collection_area_id, day_of_week, bulk_capacity_limit, anc_capacity_limit, id_capacity_limit')
        .eq('is_active', true),
      supabase
        .from('capacity_pool_schedule')
        .select('capacity_pool_id, day_of_week, bulk_capacity_limit, anc_capacity_limit, id_capacity_limit')
        .eq('is_active', true),
      supabase
        .from('public_holiday')
        .select('date, name')
        .gte('date', counts.start_date)
        .lt('date', counts.end_date)
        .eq('jurisdiction', 'WA'),
    ])

    if (scheduleResp.error) throw new Error(`collection_schedule load: ${scheduleResp.error.message}`)
    if (poolScheduleResp.error) throw new Error(`capacity_pool_schedule load: ${poolScheduleResp.error.message}`)
    if (holidayResp.error) throw new Error(`public_holiday load: ${holidayResp.error.message}`)

    const scheduleRows = scheduleResp.data ?? []
    const poolScheduleRows = poolScheduleResp.data ?? []
    const holidayRows = holidayResp.data ?? []

    counts.schedule_entries = scheduleRows.length
    counts.pool_schedule_entries = poolScheduleRows.length
    counts.holidays_in_window = holidayRows.length

    const holidaysByDate = new Map(holidayRows.map((h) => [h.date as string, h.name as string]))

    // 2. Plan per-area dates.
    const areaSchedule: ScheduleEntry[] = scheduleRows.map((r) => ({
      id: r.collection_area_id as string,
      day_of_week: r.day_of_week as number,
      bulk_capacity_limit: r.bulk_capacity_limit as number,
      anc_capacity_limit: r.anc_capacity_limit as number,
      id_capacity_limit: r.id_capacity_limit as number,
    }))
    const areaDates = planDates(areaSchedule, start, end, holidaysByDate)

    // 3. Plan per-pool dates.
    const poolSchedule: ScheduleEntry[] = poolScheduleRows.map((r) => ({
      id: r.capacity_pool_id as string,
      day_of_week: r.day_of_week as number,
      bulk_capacity_limit: r.bulk_capacity_limit as number,
      anc_capacity_limit: r.anc_capacity_limit as number,
      id_capacity_limit: r.id_capacity_limit as number,
    }))
    const poolDates = planDates(poolSchedule, start, end, holidaysByDate)

    // 4. Upsert per-area collection_date rows. On holiday: is_open=false + zero caps.
    if (areaDates.length > 0) {
      const areaRows = areaDates.map((d) => ({
        collection_area_id: d.entity_id,
        date: d.date,
        is_open: !d.is_holiday,
        for_mud: false,
        bulk_capacity_limit: d.is_holiday ? 0 : d.bulk_capacity_limit,
        anc_capacity_limit: d.is_holiday ? 0 : d.anc_capacity_limit,
        id_capacity_limit: d.is_holiday ? 0 : d.id_capacity_limit,
      }))

      const { data: inserted, error } = await supabase
        .from('collection_date')
        .upsert(areaRows, {
          onConflict: 'collection_area_id,date',
          ignoreDuplicates: true,
        })
        .select('id')

      if (error) {
        counts.failed++
        counts.errors.push(`collection_date upsert: ${error.message}`)
      } else {
        counts.collection_dates_inserted = inserted?.length ?? 0
        counts.collection_dates_skipped = areaRows.length - counts.collection_dates_inserted
      }
    }

    // 5. Upsert per-pool collection_date_pool rows. On holiday: caps=0 + is_closed=true.
    if (poolDates.length > 0) {
      const poolRows = poolDates.map((d) => ({
        capacity_pool_id: d.entity_id,
        date: d.date,
        bulk_capacity_limit: d.is_holiday ? 0 : d.bulk_capacity_limit,
        bulk_is_closed: d.is_holiday,
        anc_capacity_limit: d.is_holiday ? 0 : d.anc_capacity_limit,
        anc_is_closed: d.is_holiday,
        id_capacity_limit: d.is_holiday ? 0 : d.id_capacity_limit,
        id_is_closed: d.is_holiday,
      }))

      const { data: inserted, error } = await supabase
        .from('collection_date_pool')
        .upsert(poolRows, {
          onConflict: 'capacity_pool_id,date',
          ignoreDuplicates: true,
        })
        .select('id')

      if (error) {
        counts.failed++
        counts.errors.push(`collection_date_pool upsert: ${error.message}`)
      } else {
        counts.pool_dates_inserted = inserted?.length ?? 0
        counts.pool_dates_skipped = poolRows.length - counts.pool_dates_inserted
      }
    }

    const status = counts.failed > 0 ? 500 : 200
    console.log('generate-collection-dates', JSON.stringify(counts))
    return new Response(JSON.stringify({ ok: status === 200, ...counts }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('generate-collection-dates error:', message)
    return new Response(
      JSON.stringify({ ok: false, error: message, ...counts }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
})
