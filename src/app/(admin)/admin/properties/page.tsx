import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { canManageAllocations } from '@/lib/auth/roles'
import { PropertiesClient } from './properties-client'

export default async function PropertiesPage() {
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  const supabase = await createClient()
  const { data: role } = await supabase.rpc('current_user_role')
  const isContractorAdmin = role === 'contractor-admin'
  const canManageAllocs = canManageAllocations(role)

  return (
    <Suspense>
      <PropertiesClient clientId={clientId} isContractorAdmin={isContractorAdmin} canManageAllocations={canManageAllocs} />
    </Suspense>
  )
}
