import { Suspense } from 'react'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { AllocationsList } from './allocations-list'

export default async function AllocationsPage() {
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  return (
    <Suspense>
      <AllocationsList clientId={clientId} />
    </Suspense>
  )
}
