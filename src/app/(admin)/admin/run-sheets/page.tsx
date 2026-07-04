import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isContractorStaff } from '@/lib/auth/roles'
import { awstDateFromUtc } from '@/lib/booking/schedule-transition'
import { fetchDayStops, isValidRunDate } from '@/lib/stops/run-sheet-data'
import { groupStopsIntoRuns } from '@/lib/stops/runs'
import { RunSheetsListClient } from './run-sheets-list-client'

interface RunSheetsPageProps {
  searchParams: Promise<{ date?: string }>
}

/**
 * Admin run sheets — a read-only, date-browsable mirror of the field run picker
 * for D&M ops. Contractor-WIDE by design: stops are queried by date only (a run
 * spans councils), bounded to the contractor's clients by collection_stop RLS —
 * NOT scoped via getCurrentAdminClient(), which would fragment runs.
 *
 * The contractor-only guard below is the sole enforcement (see isContractorStaff):
 * the proxy admits client-tier to /admin/* and the (admin) layout has no role
 * guard, so a client-admin could otherwise reach this operator surface.
 */
export default async function RunSheetsPage({ searchParams }: RunSheetsPageProps) {
  const supabase = await createClient()

  const { data: role } = await supabase.rpc('current_user_role')
  if (!isContractorStaff(role)) {
    redirect('/admin')
  }

  const { date: dateParam } = await searchParams
  const date =
    dateParam && isValidRunDate(dateParam) ? dateParam : awstDateFromUtc(new Date())

  const stops = await fetchDayStops(supabase, date)
  const runs = groupStopsIntoRuns(stops)

  return <RunSheetsListClient date={date} runs={runs} />
}
