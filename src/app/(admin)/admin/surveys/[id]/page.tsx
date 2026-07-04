import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveAuditLogs } from '@/lib/audit/resolve'
import { SurveyDetailClient, type SurveyDetail } from './survey-detail-client'

interface SurveyDetailPageProps {
  params: Promise<{ id: string }>
}

export default async function SurveyDetailPage({ params }: SurveyDetailPageProps) {
  const { id } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/auth')

  const { data: survey } = await supabase
    .from('booking_survey')
    .select(
      `id, submitted_at, responses, created_at,
       booking!inner(
         id, ref, status,
         collection_area!inner(name, code),
         eligible_properties:property_id(formatted_address, address),
         booking_item(no_services, is_extra, service!inner(name), collection_date!inner(date))
       )`
    )
    .eq('id', id)
    .single()

  if (!survey) redirect('/admin/surveys')

  const auditLogs = await resolveAuditLogs(supabase, 'booking_survey', id)

  return <SurveyDetailClient survey={survey as unknown as SurveyDetail} auditLogs={auditLogs} />
}
