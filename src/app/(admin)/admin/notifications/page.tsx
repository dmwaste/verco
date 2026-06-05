import { Suspense } from 'react'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { NotificationsClient } from './notifications-client'

export default async function NotificationsPage() {
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  return (
    <Suspense>
      <NotificationsClient clientId={clientId} />
    </Suspense>
  )
}
