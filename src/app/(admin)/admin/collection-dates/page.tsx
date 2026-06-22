import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { CollectionDatesClient } from './collection-dates-client'

export default async function CollectionDatesPage() {
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''
  const clientSlug = currentClient?.slug ?? ''

  const supabase = await createClient()
  const { data: role } = await supabase.rpc('current_user_role')
  const isContractorAdmin = role === 'contractor-admin'

  return (
    <Suspense>
      <CollectionDatesClient clientId={clientId} clientSlug={clientSlug} isContractorAdmin={isContractorAdmin} />
    </Suspense>
  )
}
