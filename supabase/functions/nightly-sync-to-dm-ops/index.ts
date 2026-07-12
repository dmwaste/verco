import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from '../_shared/database.types.ts'

// Service-role only — triggered by pg_cron, no JWT validation.
// Aggregates attended bookings from Verco and upserts into DM-Ops booked_collection table.

serve(async (_req) => {
  const verco = createClient<Database>(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // NOTE: DM-Ops is a SEPARATE Supabase project with a different schema
  // (booked_collection etc.). Verco's `Database` type does not describe it, so
  // this client stays untyped — do not add <Database> here.
  const dmOps = createClient(
    Deno.env.get('DM_OPS_SUPABASE_URL')!,
    Deno.env.get('DM_OPS_SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const startedAt = new Date().toISOString()

  try {
    // ── 1. Query attended bookings with aggregation context ──────────────────
    // Attended = status IN ('Completed', 'Non-conformance', 'Nothing Presented')
    // Join through booking_item → collection_date for the date,
    // and booking → collection_area for the dm_job_code and client_id.

    const { data: bookingItems, error: queryError } = await verco
      .from('booking_item')
      .select(`
        no_services,
        actual_services,
        collection_date:collection_date_id ( date ),
        booking:booking_id (
          status,
          client_id,
          collection_area:collection_area_id ( dm_job_code )
        )
      `)
      .in('booking.status', ['Completed', 'Non-conformance', 'Nothing Presented'])

    if (queryError) {
      throw new Error(`Query failed: ${queryError.message}`)
    }

    // ── 2. Filter and aggregate ──────────────────────────────────────────────
    // Group by dm_job_code + date + client_id
    // dm_job_code is metadata only — areas without one are skipped.

    type AggKey = string
    interface AggRecord {
      dm_job_code: string
      date: string
      client_id: string
      total_booked_services: number
      total_actual_services: number
      booking_count: number
    }

    const aggregates = new Map<AggKey, AggRecord>()

    for (const item of bookingItems ?? []) {
      const booking = item.booking as unknown as {
        status: string
        client_id: string
        collection_area: { dm_job_code: string | null }
      }

      const collectionDate = item.collection_date as unknown as { date: string }

      // Skip areas without a dm_job_code — they're not synced to DM-Ops
      const dmJobCode = booking?.collection_area?.dm_job_code
      if (!dmJobCode) continue

      const date = collectionDate?.date
      if (!date) continue

      const key = `${dmJobCode}|${date}|${booking.client_id}`

      const existing = aggregates.get(key)
      if (existing) {
        existing.total_booked_services += item.no_services
        existing.total_actual_services += item.actual_services ?? item.no_services
        existing.booking_count += 1
      } else {
        aggregates.set(key, {
          dm_job_code: dmJobCode,
          date,
          client_id: booking.client_id,
          total_booked_services: item.no_services,
          total_actual_services: item.actual_services ?? item.no_services,
          booking_count: 1,
        })
      }
    }

    // ── 3. Upsert into DM-Ops booked_collection ─────────────────────────────
    // Keyed on dm_job_code + date (unique constraint in DM-Ops schema)

    const records = Array.from(aggregates.values()).map((agg) => ({
      dm_job_code: agg.dm_job_code,
      date: agg.date,
      client_id: agg.client_id,
      total_booked_services: agg.total_booked_services,
      total_actual_services: agg.total_actual_services,
      booking_count: agg.booking_count,
      synced_at: startedAt,
    }))

    if (records.length > 0) {
      // Batch upsert in chunks of 500 to stay within Supabase limits
      const BATCH_SIZE = 500
      for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE)

        const { error: upsertError } = await dmOps
          .from('booked_collection')
          .upsert(batch, { onConflict: 'dm_job_code,date' })

        if (upsertError) {
          throw new Error(
            `DM-Ops upsert failed (batch ${Math.floor(i / BATCH_SIZE) + 1}): ${upsertError.message}`
          )
        }
      }
    }

    // ── 4. Log success ───────────────────────────────────────────────────────

    await verco
      .from('sync_log')
      .insert({
        entity_type: 'nightly-sync-to-dm-ops',
        entity_id: '00000000-0000-0000-0000-000000000000',
        direction: 'outbound',
        status: 'success',
        payload: {
          records_synced: records.length,
          started_at: startedAt,
        },
      })

    console.log(`nightly-sync-to-dm-ops: synced ${records.length} aggregate records`)

    return new Response(
      JSON.stringify({ ok: true, records_synced: records.length }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error('nightly-sync-to-dm-ops error:', errorMessage)

    // Log failure
    await verco
      .from('sync_log')
      .insert({
        entity_type: 'nightly-sync-to-dm-ops',
        entity_id: '00000000-0000-0000-0000-000000000000',
        direction: 'outbound',
        status: 'failed',
        error_message: errorMessage,
        payload: { started_at: startedAt },
      })

    return new Response(
      JSON.stringify({ ok: false, error: errorMessage }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})
