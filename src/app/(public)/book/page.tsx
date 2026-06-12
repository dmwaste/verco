import { Suspense } from 'react'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { AddressForm } from './address-form'

export default async function BookAddressPage() {
  const h = await headers()
  const clientId = h.get('x-client-id') ?? ''

  // service_name drives the eligibility copy ("…qualifies for <service> collection
  // services"). `client` is a public-SELECT table, so the anon server client reads
  // it without auth. Fallback keeps the sentence sensible if a tenant leaves it null.
  let serviceName = 'verge'
  if (clientId) {
    const supabase = await createClient()
    const { data } = await supabase
      .from('client')
      .select('service_name')
      .eq('id', clientId)
      .maybeSingle()
    if (data?.service_name) serviceName = data.service_name
  }

  return (
    <Suspense>
      <AddressForm clientId={clientId} serviceName={serviceName} />
    </Suspense>
  )
}
