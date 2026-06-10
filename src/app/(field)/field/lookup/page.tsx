import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getRangerScope } from '@/lib/field/ranger-scope'
import { LookupClient } from './lookup-client'

/**
 * Ranger address lookup — the "is this pile legit?" tool. Search resolves a
 * sighted pile to a property; the detail page shows booking history and the
 * place-out window so the ranger can judge legitimate booking vs illegal
 * dumping on the spot.
 */
export default async function LookupPage() {
  const supabase = await createClient()

  const { data: role } = await supabase.rpc('current_user_role')
  if (role !== 'ranger') {
    redirect('/field')
  }

  const scope = await getRangerScope(supabase)
  if (!scope) {
    redirect('/field')
  }

  return (
    <LookupClient
      areaIds={scope.areaIds}
      clientName={scope.clientName}
    />
  )
}
