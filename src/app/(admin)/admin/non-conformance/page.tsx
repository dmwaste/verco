import { Suspense } from 'react'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { NonConformanceClient } from './non-conformance-client'

export default async function NonConformancePage() {
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  return (
    <Suspense>
      <NonConformanceClient clientId={clientId} />
    </Suspense>
  )
}
