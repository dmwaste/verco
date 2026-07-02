import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { pickCurrentFyId } from '@/lib/reports/current-fy'
import { ReportsClient } from './reports-client'

export default async function ReportsPage() {
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  // Resolve the current FY here (server shell) and pass it down — BC is FY-scoped
  // and getCurrentAdminClient() returns no FY (spec §5.3). financial_year is
  // public-SELECT; pickCurrentFyId reads the authoritative is_current flag.
  const supabase = await createClient()
  const { data: fyRows } = await supabase
    .from('financial_year')
    .select('id, is_current')
  const currentFyId = pickCurrentFyId(fyRows)

  // VER-288: viewer role resolved server-side (SECURITY DEFINER lookup on
  // user_roles) — drives per-metric audience gating. Structural: contractor-
  // only cards are never mounted (and never query) for council viewers.
  const { data: viewerRole } = await supabase.rpc('current_user_role')

  return (
    <Suspense>
      <ReportsClient clientId={clientId} currentFyId={currentFyId} viewerRole={viewerRole ?? null} />
    </Suspense>
  )
}
