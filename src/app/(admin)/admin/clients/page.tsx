import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ClientsList } from './clients-list'

export default async function ClientsPage() {
  // Contractor-level surface — the client list is cross-tenant (the `client`
  // table is public-SELECT). Gate to contractor-admin so client-tier users
  // don't see other tenants on the platform. (See QA-A06.)
  const supabase = await createClient()
  const { data: role } = await supabase.rpc('current_user_role')
  if (role !== 'contractor-admin') notFound()

  return (
    <Suspense>
      <ClientsList />
    </Suspense>
  )
}
