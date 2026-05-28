import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { SurveyForm } from './survey-form'
import { AlreadySubmitted } from './already-submitted'
import type { SurveyResponses } from './actions'

interface SurveyPageProps {
  params: Promise<{ token: string }>
}

export default async function SurveyPage({ params }: SurveyPageProps) {
  const { token } = await params
  const supabase = await createClient()

  // Look up survey by token — no auth required
  const { data: survey } = await supabase
    .from('booking_survey')
    .select('id, token, submitted_at, responses, booking_id, client_id')
    .eq('token', token)
    .single()

  if (!survey) {
    notFound()
  }

  // Already submitted — Screen 4
  if (survey.submitted_at) {
    const responses = survey.responses as unknown as SurveyResponses | null
    return (
      <main className="mx-auto w-full max-w-5xl">
        <AlreadySubmitted bookingRef={survey.booking_id} responses={responses} />
      </main>
    )
  }

  // Fetch booking details (ref, collection date, services)
  const { data: booking } = await supabase
    .from('booking')
    .select(
      `ref,
       booking_item(
         no_services, is_extra,
         service!inner(name),
         collection_date!inner(date)
       )`
    )
    .eq('id', survey.booking_id)
    .single()

  const bookingRef = booking?.ref ?? ''
  const items = (booking?.booking_item ?? []) as Array<{
    no_services: number
    is_extra: boolean
    service: { name: string }
    collection_date: { date: string }
  }>

  const collectionDate = items.length > 0 ? items[0]?.collection_date?.date ?? '' : ''

  const serviceChips = items.map((item) => ({
    name: (item.service as { name: string }).name,
    qty: item.no_services,
    isExtra: item.is_extra,
  }))

  return (
    <main className="mx-auto w-full max-w-5xl">
      <SurveyForm
        token={token}
        bookingRef={bookingRef}
        collectionDate={collectionDate}
        serviceChips={serviceChips}
      />
    </main>
  )
}
