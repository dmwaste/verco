import { Suspense } from 'react'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { SurveysListClient } from './surveys-list-client'

export default async function SurveysPage() {
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  return (
    <Suspense>
      <SurveysListClient clientId={clientId} />
    </Suspense>
  )
}
