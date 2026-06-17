import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { PublicNav } from '@/components/public/public-nav'
import { MobileFab } from '@/components/public/mobile-fab'
import { MobileBottomNav } from '@/components/public/mobile-bottom-nav'
import { adminOrigin, isAdminHostname, isFieldHostname } from '@/lib/proxy/hostnames'
import { STAFF_ROLES } from '@/lib/auth/roles'
import { faviconToIcons } from '@/lib/client/favicon'

interface ClientBranding {
  name: string
  slug: string
  logo_light_url: string | null
  primary_colour: string | null
  accent_colour: string | null
  service_name: string | null
  show_powered_by: boolean
}

async function getClientBranding(): Promise<ClientBranding | null> {
  const headerStore = await headers()
  const clientId = headerStore.get('x-client-id')

  if (!clientId) return null

  const supabase = await createClient()
  const { data } = await supabase
    .from('client')
    .select('name, slug, logo_light_url, primary_colour, accent_colour, service_name, show_powered_by')
    .eq('id', clientId)
    .single()

  return data
}

async function getAuthState(): Promise<{ isAuthenticated: boolean; isStaff: boolean }> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { isAuthenticated: false, isStaff: false }

    const { data: userRole } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .single()

    return { isAuthenticated: true, isStaff: STAFF_ROLES.some(r => r === userRole?.role) }
  } catch {
    return { isAuthenticated: false, isStaff: false }
  }
}

// Per-tenant favicon for resident pages. Runs as its own pass (separate from
// the layout body), so it does its own tiny `favicon_url` lookup rather than
// sharing the body's branding fetch — one extra indexed PK read, no cache().
//
// CRITICAL: `(public)` also renders `/auth` on the admin/field hosts, where
// `x-client-id` may be an on-behalf tenant. Mirror the body's isContractorHost
// guard so a tenant favicon never leaks onto admin/field surfaces.
export async function generateMetadata(): Promise<Metadata> {
  try {
    const headerStore = await headers()
    const host = headerStore.get('host') ?? ''
    if (isAdminHostname(host) || isFieldHostname(host)) return {}

    const clientId = headerStore.get('x-client-id')
    if (!clientId) return {}

    const supabase = await createClient()
    const { data } = await supabase
      .from('client')
      .select('favicon_url')
      .eq('id', clientId)
      .maybeSingle()

    return { icons: faviconToIcons(data?.favicon_url) }
  } catch {
    // Degrade to the default app/icon.png rather than throw during metadata resolution.
    return {}
  }
}

export default async function PublicLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const headerStore = await headers()
  const host = headerStore.get('host') ?? ''
  // On admin/field hosts, the (public) layout still wraps /auth — but the
  // resident nav, FAB, and bottom bar don't belong there. Render a minimal
  // shell with neutral Verco brand defaults instead.
  const isContractorHost = isAdminHostname(host) || isFieldHostname(host)

  if (isContractorHost) {
    return (
      <div
        className="min-h-screen bg-gray-50"
        style={{
          '--brand': '#293F52',
          '--brand-foreground': '#FFFFFF',
          '--brand-light': 'color-mix(in srgb, #293F52 8%, white)',
          '--brand-hover': 'color-mix(in srgb, #293F52 85%, black)',
          '--brand-accent': '#00E47C',
          '--brand-accent-light': 'color-mix(in srgb, #00E47C 10%, white)',
          '--brand-accent-dark': 'color-mix(in srgb, #00E47C 75%, black)',
        } as React.CSSProperties}
      >
        {children}
      </div>
    )
  }

  const [branding, { isStaff, isAuthenticated }] = await Promise.all([
    getClientBranding(),
    getAuthState(),
  ])
  const rawPrimary = branding?.primary_colour ?? '#293F52'
  const rawAccent = branding?.accent_colour ?? '#00E47C'
  const primaryColour = rawPrimary.startsWith('#') ? rawPrimary : `#${rawPrimary}`
  const accentColour = rawAccent.startsWith('#') ? rawAccent : `#${rawAccent}`
  // Admin always lives on its own host (admin.verco.au), regardless of which
  // tenant subdomain rendered this page. See adminOrigin().
  const adminUrl = `${adminOrigin(host)}/admin`

  return (
    <div
      className="min-h-screen bg-gray-50"
      style={{
        '--brand': primaryColour,
        '--brand-foreground': '#FFFFFF',
        '--brand-light': `color-mix(in srgb, ${primaryColour} 8%, white)`,
        '--brand-hover': `color-mix(in srgb, ${primaryColour} 85%, black)`,
        '--brand-accent': accentColour,
        '--brand-accent-light': `color-mix(in srgb, ${accentColour} 10%, white)`,
        '--brand-accent-dark': `color-mix(in srgb, ${accentColour} 75%, black)`,
      } as React.CSSProperties}
    >
      <PublicNav
        serviceName={branding?.service_name ?? 'Verge Collection'}
        logoUrl={branding?.logo_light_url ?? null}
        showPoweredBy={branding?.show_powered_by ?? true}
        showAdminLink={isStaff}
        showSignOut={isAuthenticated}
        adminUrl={adminUrl}
      />
      <div className="pb-16 tablet:pb-0">
        {children}
      </div>
      <MobileFab />
      <MobileBottomNav showAdminLink={isStaff} showSignOut={isAuthenticated} adminUrl={adminUrl} />
    </div>
  )
}
