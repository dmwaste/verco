import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { stopLogsMattresses } from '@/lib/stops/mattress'
import { UNASSIGNED_RUN_SEGMENT } from '@/lib/stops/runs'
import type { WasteStream } from '@/lib/stops/stops'
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
       client:client_id(mattress_closeout_stream),
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

  // Mattress logging (#487): the client row names the pass that must enter a
  // count at closeout (VV bulk); NULL = tenant never logs. Server-derived so
  // the client component can't be talked into skipping the prompt — the
  // server action re-derives it anyway (fail-closed).
  const clientRow = stop.client as unknown as {
    mattress_closeout_stream: WasteStream | null
  } | null
  const mattressRequired = stopLogsMattresses(
    clientRow?.mattress_closeout_stream ?? null,
    stop.stream,
  )

  return (
    <StopCloseoutClient
      stop={stop as unknown as StopDetail}
      runHref={runHref}
      mattressRequired={mattressRequired}
    />
  )
}
