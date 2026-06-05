import { Suspense } from 'react'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { UsersClient } from './users-client'

export default async function UsersPage() {
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  return (
    <Suspense>
      <UsersClient clientId={clientId} />
    </Suspense>
  )
}
