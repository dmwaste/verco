import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from '../_shared/database.types.ts'

// Service-role only — triggered by pg_cron daily.
// Closes NCN and NP notices that have been in 'Issued' status for 14+ days
// with no resident dispute.

serve(async (_req) => {
  const supabase = createClient<Database>(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - 14)
  const cutoff = cutoffDate.toISOString()

  const results = {
    ncn_closed: 0,
    np_closed: 0,
    ncn_failed: 0,
    np_failed: 0,
  }

  try {
    // Close NCN notices older than 14 days in 'Issued' status
    const { data: ncnClosed, error: ncnError } = await supabase
      .from('non_conformance_notice')
      .update({
        status: 'Closed',
        resolved_at: new Date().toISOString(),
        resolution_notes: 'Auto-closed — no dispute within 14 days',
      })
      .eq('status', 'Issued')
      .lt('reported_at', cutoff)
      .select('id')

    if (ncnError) {
      results.ncn_failed++
      console.error('NCN auto-close error:', ncnError.message)
    }

    // Close NP notices older than 14 days in 'Issued' status
    const { data: npClosed, error: npError } = await supabase
      .from('nothing_presented')
      .update({
        status: 'Closed',
        resolved_at: new Date().toISOString(),
        resolution_notes: 'Auto-closed — no dispute within 14 days',
      })
      .eq('status', 'Issued')
      .lt('reported_at', cutoff)
      .select('id')

    if (npError) {
      results.np_failed++
      console.error('NP auto-close error:', npError.message)
    }

    results.ncn_closed = ncnClosed?.length ?? 0
    results.np_closed = npClosed?.length ?? 0

    console.log(`Auto-close complete: ${results.ncn_closed} NCN, ${results.np_closed} NP`)

    // Return 500 on any failure so pg_cron logs a non-success HTTP status —
    // otherwise silent partial failures look fine to monitoring.
    const failed = results.ncn_failed + results.np_failed
    const status = failed > 0 ? 500 : 200
    const ok = failed === 0
    return new Response(JSON.stringify({ ok, ...results }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('Auto-close error:', err)
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }
})
