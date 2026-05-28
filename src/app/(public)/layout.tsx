import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { PublicNav } from '@/components/public/public-nav'
import { MobileFab } from '@/components/public/mobile-fab'
import { MobileBottomNav } from '@/components/public/mobile-bottom-nav'
import { isAdminHostname, isFieldHostname } from '@/lib/proxy/hostnames'
import { STAFF_ROLES } from '@/lib/auth/server'

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

async function getIsStaff(): Promise<boolean> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return false

    const { data: userRole } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .single()

    return STAFF_ROLES.includes(userRole?.role ?? '')
  } catch {
    return false
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

  const [branding, isStaff] = await Promise.all([
    getClientBranding(),
    getIsStaff(),
  ])
  const rawPrimary = branding?.primary_colour ?? '#293F52'
  const rawAccent = branding?.accent_colour ?? '#00E47C'
  const primaryColour = rawPrimary.startsWith('#') ? rawPrimary : `#${rawPrimary}`
  const accentColour = rawAccent.startsWith('#') ? rawAccent : `#${rawAccent}`

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
      />
      <div className="pb-16 tablet:pb-0">
        {children}
      </div>
      <MobileFab />
      <MobileBottomNav showAdminLink={isStaff} />
    </div>
  )
}
