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
  const supabase = await createClient()
  const { data: fyRows } = await supabase
    .from('financial_year')
    .select('id, label, start_date, end_date, is_current')

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
