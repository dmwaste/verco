'use client'

import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'
import { PageHeader } from '@/components/admin/page-header'

export function ClientsList() {
  const supabase = createClient()

  const { data: clients, isLoading } = useQuery({
    queryKey: ['admin-clients'],
    queryFn: async () => {
      const { data } = await supabase
        .from('client')
        .select('id, name, slug, is_active, primary_colour, collection_area(count), sub_client(count)')
        .order('name')
      return data ?? []
    },
  })

  const clientList = clients ?? []

  return (
    <>
      {/* Header */}
      <PageHeader
        title="Clients"
        subtitle={isLoading ? 'Loading...' : `${clientList.length} client${clientList.length !== 1 ? 's' : ''}`}
      >
        <Link
          href="/admin/clients/new"
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#293F52] px-4 py-2 text-body-sm font-semibold text-white"
        >
          + New Client
        </Link>
      </PageHeader>

      {/* Card grid */}
      <div className="px-7 py-6">
        {isLoading && (
          <div className="grid grid-cols-1 gap-4 tablet:grid-cols-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-[140px] animate-pulse rounded-xl border-[1.5px] border-gray-100 bg-white" />
            ))}
          </div>
        )}

        {!isLoading && clientList.length === 0 && (
          <div className="rounded-xl bg-white p-12 text-center shadow-sm">
            <p className="text-body-sm text-gray-400">No clients configured yet.</p>
            <Link
              href="/admin/clients/new"
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-[#293F52] px-4 py-2 text-body-sm font-semibold text-white"
            >
              + Create your first client
            </Link>
          </div>
        )}

        {!isLoading && clientList.length > 0 && (
          <div className="grid grid-cols-1 gap-4 tablet:grid-cols-2">
            {clientList.map((client) => {
              const areaCount = (client.collection_area as unknown as { count: number }[])?.[0]?.count ?? 0
              const subClientCount = (client.sub_client as unknown as { count: number }[])?.[0]?.count ?? 0
              const colour = client.primary_colour ?? '#293F52'
              const initial = client.name.charAt(0).toUpperCase()

              return (
                <Link
                  key={client.id}
                  href={`/admin/clients/${client.id}`}
                  className="rounded-xl border-[1.5px] border-gray-100 bg-white p-5 transition-shadow hover:shadow-md"
                >
                  <div className="mb-3 flex items-center gap-3">
                    <div
                      className="flex size-10 shrink-0 items-center justify-center rounded-lg font-[family-name:var(--font-heading)] text-base font-bold text-white"
                      style={{ backgroundColor: colour }}
                    >
                      {initial}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body font-semibold text-[#293F52]">{client.name}</div>
                      <div className="text-2xs text-gray-400">{client.slug}</div>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-semibold ${
                        client.is_active
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {client.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-2xs text-gray-500">
                    <div><span className="text-gray-400">Areas:</span> {areaCount}</div>
                    <div><span className="text-gray-400">Sub-clients:</span> {subClientCount}</div>
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
