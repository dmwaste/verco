import { Suspense } from 'react'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { DetailsForm } from './details-form'

export default async function DetailsPage() {
  const h = await headers()
  const clientId = h.get('x-client-id') ?? ''

  // contact_phone backs the "contact our team on …" note under the location
  // picker. `client` is public-SELECT, so the anon server client reads it.
  let contactPhone = ''
  if (clientId) {
    const supabase = await createClient()
    const { data } = await supabase
      .from('client')
      .select('contact_phone')
      .eq('id', clientId)
      .maybeSingle()
    if (data?.contact_phone) contactPhone = data.contact_phone
  }

  return (
    <Suspense>
      <DetailsForm contactPhone={contactPhone} />
    </Suspense>
  )
}
