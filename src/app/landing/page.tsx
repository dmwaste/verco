import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import {
  adminOrigin,
  X_VERCO_ROOT,
  X_VERCO_BREF_MISS,
} from '@/lib/proxy/hostnames'
import { VercoLogo } from '@/components/branding/verco-logo'
import { Hero } from './hero'
import { RecoveryBanner } from './recovery-banner'
import { CouncilPicker } from './council-picker'
import { HowItWorks } from './how-it-works'
import { ForCouncils } from './for-councils'
import { OperatedBy } from './operated-by'
import { pickerState, attachSubClients } from './picker-state'

/**
 * Root landing for `verco.au` — marketing + routing surface for three
 * audiences: residents finding their council (incl. stale /b/<ref> SMS-link
 * holders, who see the recovery banner), prospective council partners, and
 * staff heading to admin.
 *
 * Gated by `x-verco-root` (set only by proxy Branch Z; stripped from inbound
 * requests on tenant/admin branches) — without it the page 404s so the root
 * surface never leaks onto a tenant host.
 */

// metadataBase is load-bearing: without it the self-hosted standalone build
// resolves the canonical + og:image against http://localhost:3000.
export const metadata: Metadata = {
  metadataBase: new URL('https://verco.au'),
  title: 'Verco — Bulk verge collection, booked online',
  description:
    'Verco is the booking platform behind pre-booked residential verge collection for WA councils — white-labelled for your community and delivered end-to-end by D&M Waste Management.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'Verco — Bulk verge collection, booked online',
    description:
      'Pre-booked residential verge collection for WA councils, delivered end-to-end by D&M Waste Management.',
    url: '/',
    siteName: 'Verco',
    locale: 'en_AU',
    type: 'website',
    images: [
      {
        url: '/landing/og.jpg',
        width: 1200,
        height: 630,
        alt: 'Aerial view of a D&M crew collecting green waste from residential verges',
      },
    ],
  },
  twitter: { card: 'summary_large_image' },
}

const ORGANISATION_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Verco',
  url: 'https://verco.au',
  logo: 'https://verco.au/icons/verco-512.png',
  email: 'bookings@verco.au',
  areaServed: 'Western Australia',
  parentOrganization: {
    '@type': 'Organization',
    name: 'D&M Waste Management',
  },
} as const

// Static-literal JSON-LD rendered as plain text children (no raw-HTML API).
// HTML-sensitive characters are emitted as JSON unicode escapes so React has
// nothing to entity-escape and the script body stays valid JSON for crawlers.
const ORGANISATION_JSON_LD_TEXT = JSON.stringify(ORGANISATION_JSON_LD).replace(
  /[<>&]/g,
  (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
)

export default async function LandingPage() {
  const h = await headers()
  if (h.get(X_VERCO_ROOT) !== '1') notFound()

  const showRecoveryBanner = h.get(X_VERCO_BREF_MISS) === '1'

  // Staff sign-in always targets the single operator host (admin.verco.au),
  // not a per-tenant subdomain. See adminOrigin().
  const adminUrl = `${adminOrigin(h.get('host') ?? '')}/admin`

  const supabase = await createClient()
  const { data: clients, error } = await supabase
    .from('client')
    .select(
      'id, slug, name, custom_domain, service_name, primary_colour, accent_colour, logo_light_url',
    )
    .eq('is_active', true)
    .not('custom_domain', 'is', null)
    .order('name')

  if (error) {
    console.error(`[landing] client query failed: ${error.message}`)
  }

  // Active member councils, for the multi-LGA recognition line. A failure
  // here is non-fatal — cards still render, just without their serving line.
  const { data: subClients, error: subError } = await supabase
    .from('sub_client')
    .select('client_id, name')
    .eq('is_active', true)
    .order('name')

  if (subError) {
    console.error(`[landing] sub_client query failed: ${subError.message}`)
  }

  const picker = pickerState(
    clients ? attachSubClients(clients, subClients) : null,
    error,
  )

  return (
    <main className="flex min-h-full flex-col">
      {/* Route-scoped smooth scrolling: scroll-behavior must live on the
          document scroller, so it's emitted by this page only (never
          globals.css — admin/field surfaces shouldn't inherit it). */}
      <style>{`@media (prefers-reduced-motion: no-preference){html{scroll-behavior:smooth}}`}</style>
      <script type="application/ld+json">{ORGANISATION_JSON_LD_TEXT}</script>

      <header className="bg-white px-6">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between">
          <VercoLogo variant="colour" />
          <a
            href={adminUrl}
            className="text-[15px] font-semibold text-[#293F52] hover:underline"
          >
            Staff sign in
          </a>
        </div>
      </header>

      {showRecoveryBanner && <RecoveryBanner />}

      <Hero />
      <CouncilPicker state={picker} />
      <HowItWorks />
      <ForCouncils />
      <OperatedBy />
    </main>
  )
}
