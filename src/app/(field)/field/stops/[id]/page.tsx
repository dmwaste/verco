import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { UNASSIGNED_RUN_SEGMENT } from '@/lib/stops/runs'
import { StopCloseoutClient, type StopDetail } from './stop-closeout-client'

interface StopCloseoutPageProps {
  params: Promise<{ id: string }>
}

/**
 * Per-stop closeout: Complete / NCN / NP for ONE waste-stream pass of a
 * booking. Structural PII exclusion — never selects contact fields; the
 * address is denormalised on the stop row.
 */
export default async function StopCloseoutPage({ params }: StopCloseoutPageProps) {
  const { id } = await params
  const supabase = await createClient()

  const { data: stop } = await supabase
    .from('collection_stop')
    .select(
      `id, stream, status, address, latitude, longitude, services_summary,
       stop_sequence, driver_serial,
       collection_date:collection_date_id(date),
       booking:booking_id(
         id, ref, status, type, location, notes,
         booking_item(id, no_services, actual_services, is_extra,
           service!inner(name, waste_stream))
       )`,
    )
    .eq('id', id)
    .single()

  if (!stop) {
    redirect('/field')
  }

  const date = (stop.collection_date as unknown as { date: string }).date
  const runHref = `/field/runs/${date}/${encodeURIComponent(
    stop.driver_serial ?? UNASSIGNED_RUN_SEGMENT,
  )}`

  return (
    <StopCloseoutClient stop={stop as unknown as StopDetail} runHref={runHref} />
  )
}
