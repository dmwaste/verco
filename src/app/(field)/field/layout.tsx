import type { Metadata, Viewport } from 'next'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { getRangerScope } from '@/lib/field/ranger-scope'
import { FieldLayoutClient } from './field-layout-client'

// PWA metadata scoped to the field surface via this nested layout — a root
// app/manifest.ts would advertise the Verco-brand manifest on white-label
// resident pages too.
export const metadata: Metadata = {
  title: 'Verco Field',
  manifest: '/field.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Verco Field',
  },
  icons: {
    apple: '/icons/apple-touch-icon.png',
  },
}

export const viewport: Viewport = {
  themeColor: '#293F52',
  width: 'device-width',
  initialScale: 1,
  // Draw under the iOS notch/home-indicator; safe-area insets are handled
  // with env() padding in FieldLayoutClient.
  viewportFit: 'cover',
}

export default async function FieldLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/auth')
  }

  // Get user role — structural check, field/ranger only
  const { data: role } = await supabase.rpc('current_user_role')

  if (!role || !['field', 'ranger'].includes(role)) {
    redirect('/auth')
  }

  const roleLabel = role === 'ranger' ? 'Ranger' : 'Field Staff'

  // Collection-area codes for the header pill. collection_area is public-SELECT
  // (RLS USING(true)) — a raw query returns EVERY client's areas, so a ranger
  // must app-filter to their own scope (else a Verge Valet ranger sees KWN-*).
  // Rangers are client-scoped via getRangerScope; field crew are
  // contractor-tier and legitimately span all clients, so they keep the
  // full active list.
  let areaCodes = ''
  if (role === 'ranger') {
    const scope = await getRangerScope(supabase)
    areaCodes = scope?.areaCodes.join(' · ') ?? ''
  } else {
    const { data: areas } = await supabase
      .from('collection_area')
      .select('code')
      .eq('is_active', true)
      .order('code')
    areaCodes = (areas ?? []).map((a) => a.code).join(' · ')
  }

  // Fetch tenant branding for white-label CSS variables
  const headerStore = await headers()
  const clientId = headerStore.get('x-client-id')
  let primaryColour = '#293F52'
  let accentColour = '#00E47C'

  if (clientId) {
    const { data: client } = await supabase
      .from('client')
      .select('primary_colour, accent_colour')
      .eq('id', clientId)
      .single()

    if (client?.primary_colour) primaryColour = client.primary_colour.startsWith('#') ? client.primary_colour : `#${client.primary_colour}`
    if (client?.accent_colour) accentColour = client.accent_colour.startsWith('#') ? client.accent_colour : `#${client.accent_colour}`
  }

  return (
    <div
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
      <FieldLayoutClient role={role} roleLabel={roleLabel} areaCodes={areaCodes}>
        {children}
      </FieldLayoutClient>
    </div>
  )
}
