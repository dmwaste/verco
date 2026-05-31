import { redirect, notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ClientDetail } from './client-detail'

interface ClientDetailPageProps {
  params: Promise<{ id: string }>
}

export default async function ClientDetailPage({ params }: ClientDetailPageProps) {
  const { id } = await params
  const supabase = await createClient()

  // Client management is a contractor-level surface. Gate to contractor-admin —
  // the `client` table is public-SELECT (USING(is_active)), so without this a
  // client-tier user could fetch another tenant's config by id. (See QA-A06.)
  const { data: role } = await supabase.rpc('current_user_role')
  if (role !== 'contractor-admin') notFound()

  const { data: client } = await supabase
    .from('client')
    .select('*')
    .eq('id', id)
    .single()

  if (!client) redirect('/admin/clients')

  // Preload sub-clients for Sub-Clients + Collection Areas tabs
  const { data: subClients } = await supabase
    .from('sub_client')
    .select('id, name, code, is_active')
    .eq('client_id', id)
    .order('code')

  // Preload categories + services for the Rules tab. Exclude Illegal Dumping
  // (`id`) — its capacity is controlled per-date via collection_date.id_capacity_limit
  // (set by ops or via the date generator), not via per-area allocation/service
  // rules. Filtering at the source means RulesTab can't accidentally render ID.
  const [categoriesResult, servicesResult] = await Promise.all([
    supabase.from('category').select('id, name, code').neq('code', 'id').order('name'),
    supabase.from('service').select('id, name, category_id').order('name'),
  ])

  const keptCategoryIds = new Set((categoriesResult.data ?? []).map((c) => c.id))
  const filteredServices = (servicesResult.data ?? []).filter((s) => keptCategoryIds.has(s.category_id))

  return (
    <ClientDetail
      client={client}
      subClients={subClients ?? []}
      categories={categoriesResult.data ?? []}
      services={filteredServices}
    />
  )
}
