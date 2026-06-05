import { Suspense } from 'react'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { ServiceTicketsClient } from './service-tickets-client'

export default async function ServiceTicketsPage() {
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  return (
    <Suspense>
      <ServiceTicketsClient clientId={clientId} />
    </Suspense>
  )
}
