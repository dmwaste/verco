import { Suspense } from 'react'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { NothingPresentedClient } from './nothing-presented-client'

export default async function NothingPresentedPage() {
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  return (
    <Suspense>
      <NothingPresentedClient clientId={clientId} />
    </Suspense>
  )
}
