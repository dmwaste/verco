import { Suspense } from 'react'
import { headers } from 'next/headers'
import { ServicesForm } from './services-form'

export default async function ServicesPage() {
  const h = await headers()
  const clientSlug = h.get('x-client-slug') ?? ''

  return (
    <Suspense>
      <ServicesForm clientSlug={clientSlug} />
    </Suspense>
  )
}
