import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isContractorStaff } from '@/lib/auth/roles'
import { UNASSIGNED_RUN_SEGMENT } from '@/lib/stops/runs'
import { fetchRunStops, fetchRunMeta, isValidRunDate } from '@/lib/stops/run-sheet-data'
import { RunSheetDetailClient } from './run-sheet-detail-client'

interface RunSheetDetailPageProps {
  params: Promise<{ date: string; driver: string }>
}

/**
 * Admin run-sheet detail for one (date, driver) run — read-only oversight +
 * printable working sheet. Same contractor-only guard as the list; the stop /
 * run-meta reads are shared with the field run sheet (@/lib/stops/run-sheet-data).
 */
export default async function RunSheetDetailPage({ params }: RunSheetDetailPageProps) {
  const supabase = await createClient()

  const { data: role } = await supabase.rpc('current_user_role')
  if (!isContractorStaff(role)) {
    redirect('/admin')
  }

  const { date, driver: rawDriver } = await params
  if (!isValidRunDate(date)) {
    redirect('/admin/run-sheets')
  }
  const driver = decodeURIComponent(rawDriver)
  const isUnassigned = driver === UNASSIGNED_RUN_SEGMENT

  const stops = await fetchRunStops(supabase, date, driver)
  const runMeta = await fetchRunMeta(supabase, date, driver)

  return (
    <RunSheetDetailClient
      date={date}
      driverSerial={isUnassigned ? null : driver}
      stops={stops}
      runMeta={runMeta}
    />
  )
}
