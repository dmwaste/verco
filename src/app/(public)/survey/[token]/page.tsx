import { notFound } from 'next/navigation'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { SurveyForm } from './survey-form'
import { AlreadySubmitted } from './already-submitted'
import { SurveyUnavailable } from './survey-unavailable'

interface SurveyPageProps {
  params: Promise<{ token: string }>
}

/** Shape returned by the get_survey_by_token RPC (jsonb). */
interface SurveyByToken {
  submitted: boolean
  booking_ref: string
  collection_date: string | null
  service_chips: Array<{ name: string; qty: number; isExtra: boolean }>
}

interface SurveyBranding {
  logoUrl: string | null
  serviceName: string
  clientName: string
}

/**
 * Tenant branding for the survey header — resolved from the host (`x-client-id`,
 * set by the proxy) via the public-SELECT client table, the same source the
 * (public) layout uses for the nav logo + brand colours. Falls back to a
 * generic label if the header/row is missing.
 */
async function getSurveyBranding(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<SurveyBranding> {
  const fallback: SurveyBranding = {
    logoUrl: null,
    serviceName: 'Verge Collection',
    clientName: 'Verge Collection',
  }
  const clientId = (await headers()).get('x-client-id')
  if (!clientId) return fallback

  const { data } = await supabase
    .from('client')
    .select('name, service_name, logo_light_url')
    .eq('id', clientId)
    .single()
  if (!data) return fallback

  return {
    logoUrl: data.logo_light_url,
    serviceName: data.service_name ?? data.name,
    clientName: data.name,
  }
}

export default async function SurveyPage({ params }: SurveyPageProps) {
  const { token } = await params
  const supabase = await createClient()

  // Token-gated public read. The resident is logged out (anon role), so this
  // goes through the SECURITY DEFINER RPC — booking_survey has no anon RLS.
  // NULL data => unknown token => 404. An error (transport/DB) is NOT a 404:
  // the link may be valid, so offer a retry rather than a dead end.
  let data: unknown = null
  let failed = false
  try {
    const res = await supabase.rpc('get_survey_by_token', { p_token: token })
    if (res.error) failed = true
    else data = res.data
  } catch {
    failed = true
  }

  if (failed) {
    return (
      <main className="mx-auto w-full max-w-2xl">
        <SurveyUnavailable />
      </main>
    )
  }

  if (!data) {
    notFound()
  }

  const survey = data as SurveyByToken

  if (survey.submitted) {
    return (
      <main className="mx-auto w-full max-w-2xl">
        <AlreadySubmitted />
      </main>
    )
  }

  const branding = await getSurveyBranding(supabase)

  return (
    <main className="mx-auto w-full max-w-2xl">
      <SurveyForm
        token={token}
        bookingRef={survey.booking_ref}
        collectionDate={survey.collection_date ?? ''}
        serviceChips={survey.service_chips}
        clientLogoUrl={branding.logoUrl}
        serviceName={branding.serviceName}
        clientName={branding.clientName}
      />
    </main>
  )
}
