import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { canManageAllocations } from '@/lib/auth/roles'
import { AllocationsList } from './allocations-list'

export default async function AllocationsPage() {
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  // Contractor tier + client-admin may adjust overrides (RLS enforces the write;
  // this gates the edit UI). client-staff / read-only roles see the list only.
  const supabase = await createClient()
  const { data: role } = await supabase.rpc('current_user_role')
  const canManage = canManageAllocations(role)

  return (
    <Suspense>
      <AllocationsList clientId={clientId} canManage={canManage} />
    </Suspense>
  )
}
