import { Suspense } from 'react'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { ReportsClient } from './reports-client'

export default async function ReportsPage() {
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  return (
    <Suspense>
      <ReportsClient clientId={clientId} />
    </Suspense>
  )
}
