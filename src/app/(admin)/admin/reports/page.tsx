import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { ReportsClient } from './reports-client'

export default async function ReportsPage() {
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  // Financial years feed the standard period presets (VER-297: This/Last FY
  // resolve from the financial_year table — TY = is_current, LY = the prior
  // row). financial_year is public-SELECT; resolution lives in
  // lib/reports/periods.ts.
  // Ordered for deterministic is_current resolution if a rollover race ever
  // leaves two current rows; a failed fetch yields [] → the FY presets
  // resolve as `unresolved` and cards pause instead of widening to all-time.
  const supabase = await createClient()
  const { data: fyRows } = await supabase
    .from('financial_year')
    .select('id, label, start_date, end_date, is_current')
    .order('start_date', { ascending: false })

  // VER-288: viewer role resolved server-side (SECURITY DEFINER lookup on
  // user_roles) — drives per-metric audience gating. Structural: contractor-
  // only cards are never mounted (and never query) for council viewers.
  const { data: viewerRole } = await supabase.rpc('current_user_role')

  return (
    <Suspense>
      <ReportsClient
        clientId={clientId}
        fyRows={fyRows ?? []}
        viewerRole={viewerRole ?? null}
      />
    </Suspense>
  )
}
