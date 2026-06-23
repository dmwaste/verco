'use client'

import { Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { BackLink } from '@/components/admin/back-link'
import type { Database } from '@/lib/supabase/types'
import { GeneralTab } from './tabs/general-tab'
import { BrandingTab } from './tabs/branding-tab'
import { NotificationsTab } from './tabs/notifications-tab'
import { FaqsTab } from './tabs/faqs-tab'
import { TermsTab } from './tabs/terms-tab'
import { SubClientsTab } from './tabs/sub-clients-tab'
import { CollectionAreasTab } from './tabs/collection-areas-tab'
import { RulesTab } from './tabs/rules-tab'

type Client = Database['public']['Tables']['client']['Row']

interface SubClient {
  id: string
  name: string
  code: string
  is_active: boolean
}

interface Category {
  id: string
  name: string
  code: string
}

interface Service {
  id: string
  name: string
  category_id: string
}

interface ClientDetailProps {
  client: Client
  subClients: SubClient[]
  categories: Category[]
  services: Service[]
}

const TABS = [
  { key: 'general', label: 'General' },
  { key: 'branding', label: 'Branding' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'faqs', label: 'FAQs' },
  { key: 'terms', label: 'Terms & Conditions' },
  { key: 'rules', label: 'Rules' },
  { key: 'sub-clients', label: 'Sub-Clients' },
  { key: 'areas', label: 'Collection Areas' },
] as const

type TabKey = (typeof TABS)[number]['key']

export function ClientDetail({ client, subClients, categories, services }: ClientDetailProps) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const activeTab = (searchParams.get('tab') as TabKey) || 'general'
  const colour = client.primary_colour ?? '#293F52'
  const initial = client.name.charAt(0).toUpperCase()

  function setTab(tab: TabKey) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('tab', tab)
    router.replace(`?${params.toString()}`, { scroll: false })
  }

  return (
    <Suspense>
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="bg-white px-7 pb-0 pt-6">
          <BackLink href="/admin/clients" label="Back to Clients" />
          <div className="mb-4 flex items-center gap-3">
            <div
              className="flex size-9 shrink-0 items-center justify-center rounded-lg font-[family-name:var(--font-heading)] text-sm font-bold text-white"
              style={{ backgroundColor: colour }}
            >
              {initial}
            </div>
            <div>
              <h1 className="font-[family-name:var(--font-heading)] text-lg font-bold text-[#293F52]">
                {client.name}
              </h1>
              <div className="text-2xs text-gray-400">
                {client.slug} &middot; {client.is_active ? 'Active' : 'Inactive'}
              </div>
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex gap-0 border-b border-gray-100">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setTab(tab.key)}
                className={cn(
                  'px-4 py-2.5 text-body-sm font-medium transition-colors',
                  activeTab === tab.key
                    ? 'border-b-2 border-[#00E47C] font-semibold text-[#293F52]'
                    : 'text-gray-400 hover:text-gray-600'
                )}
                style={activeTab === tab.key ? { marginBottom: '-1px' } : undefined}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto bg-gray-50 px-7 py-6">
          {activeTab === 'general' && <GeneralTab client={client} />}
          {activeTab === 'branding' && <BrandingTab client={client} />}
          {activeTab === 'notifications' && <NotificationsTab client={client} />}
          {activeTab === 'faqs' && <FaqsTab client={client} />}
          {activeTab === 'terms' && <TermsTab client={client} />}
          {activeTab === 'rules' && (
            <RulesTab client={client} categories={categories} services={services} />
          )}
          {activeTab === 'sub-clients' && <SubClientsTab client={client} subClients={subClients} />}
          {activeTab === 'areas' && (
            <CollectionAreasTab client={client} subClients={subClients} />
          )}
        </div>
      </div>
    </Suspense>
  )
}
