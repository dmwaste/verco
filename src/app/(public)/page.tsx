import Link from 'next/link'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { HeroSearch } from './hero-search'

interface ClientBranding {
  name: string
  service_name: string | null
  show_powered_by: boolean
  landing_headline: string | null
  landing_subheading: string | null
  logo_light_url: string | null
  hero_banner_url: string | null
  privacy_policy_url: string | null
}

async function getBranding(): Promise<ClientBranding> {
  const headerStore = await headers()
  const clientId = headerStore.get('x-client-id')

  if (!clientId) {
    return { name: 'Verge Collection', service_name: 'Verge Collection Bookings', show_powered_by: true, landing_headline: null, landing_subheading: null, logo_light_url: null, hero_banner_url: null, privacy_policy_url: null }
  }

  const supabase = await createClient()
  const { data } = await supabase
    .from('client')
    .select('name, service_name, show_powered_by, landing_headline, landing_subheading, logo_light_url, hero_banner_url, privacy_policy_url')
    .eq('id', clientId)
    .single()

  return data ?? { name: 'Verge Collection', service_name: 'Verge Collection Bookings', show_powered_by: true, landing_headline: null, landing_subheading: null, logo_light_url: null, hero_banner_url: null, privacy_policy_url: null }
}

const FEATURES = [
  {
    title: 'Included in Your Rates',
    body: 'Your annual allocation is already included in council rates. Book your included services first — extra services are available if you need more.',
    colorClass: 'bg-[var(--brand-accent-light)]',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--brand-accent-dark)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    ),
  },
  {
    title: 'Choose Your Date',
    body: 'See all available collection dates for your area and pick the one that suits you. Dates are shown in real-time so you always know what\u2019s available.',
    colorClass: 'bg-[#E8EEF2]',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
    ),
  },
  {
    title: 'Reminders Sent to You',
    body: 'We\u2019ll send a reminder SMS and email before your collection date so you don\u2019t forget to place your items on the verge by 7am.',
    colorClass: 'bg-[#FFF3EA]',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#FF8C42" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
    ),
  },
]

const STEPS = [
  { title: 'Search your address', body: 'Enter your property address to check eligibility and view your annual allocation.' },
  { title: 'Select services & date', body: 'Choose your waste types and pick an available collection date.' },
  { title: 'Confirm & pay if needed', body: 'Included services go straight through. Extra services are charged via Stripe.' },
  { title: 'Place items out by 7am', body: 'We\u2019ll remind you. Items must be on the verge by 7am on collection day.' },
  { title: 'We collect & process', body: 'Your waste is collected and responsibly processed. You\u2019ll get a completion notification.' },
]

// Per-service descriptions. Service names live in the DB (no description
// column), so we map by name. Keys cover both short ("General") and long
// ("General Waste") forms \u2014 different clients may rename.
const SERVICE_DESCRIPTIONS: Record<string, string> = {
  'General': 'Household bulk items \u2014 furniture, timber, general rubbish',
  'General Waste': 'Household bulk items \u2014 furniture, timber, general rubbish',
  'Green': 'Garden organics \u2014 prunings, lawn clippings, branches',
  'Green Waste': 'Garden organics \u2014 prunings, lawn clippings, branches',
  'Mattress': 'Bed mattresses of any size \u2014 single, double, queen, king',
  'E-Waste': 'Electronics \u2014 TVs, computers, monitors, appliances',
  'Whitegoods': 'Fridges, washing machines, dryers, dishwashers',
}

const CATEGORY_TAG: Record<string, { label: string; tagClass: string }> = {
  bulk: {
    label: 'Bulk',
    tagClass: 'bg-[var(--brand-accent-light)] text-[var(--brand-accent-dark)]',
  },
  anc: {
    label: 'Ancillary',
    tagClass: 'bg-[#E8EEF2] text-[var(--brand)]',
  },
}

interface ClientService {
  name: string
  desc: string
  tag: string
  tagClass: string
}

async function getClientServices(clientId: string | null): Promise<ClientService[]> {
  if (!clientId) return []
  const supabase = await createClient()
  // Distinct services enabled for ANY area of this client. Excludes the
  // `id` (illegal dumping) category since IDs aren't bookable by residents.
  const { data } = await supabase
    .from('service_rules')
    .select('service:service_id!inner(name, is_active, category:category_id!inner(code)), collection_area:collection_area_id!inner(client_id)')
    .eq('collection_area.client_id', clientId)

  if (!data) return []

  const seen = new Set<string>()
  const result: ClientService[] = []
  for (const row of data) {
    const svc = Array.isArray(row.service) ? row.service[0] : row.service
    if (!svc || !svc.is_active) continue
    if (seen.has(svc.name)) continue
    const cat = Array.isArray(svc.category) ? svc.category[0] : svc.category
    if (!cat || cat.code === 'id') continue
    const tag = CATEGORY_TAG[cat.code] ?? CATEGORY_TAG.bulk
    seen.add(svc.name)
    result.push({
      name: svc.name,
      desc: SERVICE_DESCRIPTIONS[svc.name] ?? '',
      tag: tag.label,
      tagClass: tag.tagClass,
    })
  }
  // Bulk before Ancillary, then alphabetical within category.
  return result.sort((a, b) => {
    if (a.tag !== b.tag) return a.tag === 'Bulk' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export default async function LandingPage() {
  const branding = await getBranding()
  const serviceName = branding.service_name ?? 'Verge Collection'
  const headline = branding.landing_headline ?? `Book Your\nVerge Collection\nin Minutes`
  const subheading = branding.landing_subheading ?? 'Simple online booking for bulk verge collection. Check your property eligibility, choose your services, and pick a date.'

  const headerStore = await headers()
  const clientId = headerStore.get('x-client-id')
  const services = await getClientServices(clientId)

  return (
    <div className="flex min-h-screen flex-col">
      {/* Hero */}
      <section
        className={`relative px-8 py-20 lg:px-20 lg:py-24${branding.hero_banner_url ? '' : ' bg-gradient-to-br from-[var(--brand-hover)] via-[var(--brand)] to-[color-mix(in_srgb,var(--brand)_60%,white)]'}`}
        style={branding.hero_banner_url ? { backgroundImage: `url("${branding.hero_banner_url}")`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
      >
        {/* Tenant hero banner present → lay a left-weighted brand scrim over the
            image so the white headline + accent tag stay legible (heavy left
            where the text sits, fading right where the banner shows). No banner
            → the brand gradient on the section itself is the backdrop. */}
        {branding.hero_banner_url && (
          <div
            className="pointer-events-none absolute inset-0"
            style={{ background: 'linear-gradient(to right, color-mix(in srgb, var(--brand) 92%, transparent), color-mix(in srgb, var(--brand) 72%, transparent) 50%, color-mix(in srgb, var(--brand) 30%, transparent))' }}
          />
        )}
        {/* Decorative radials — use accent colour. Clipped to the hero so they
            don't leak; kept in a sibling layer so the autocomplete dropdown can
            extend below the hero without being cut off. */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -right-32 -top-32 size-[500px] rounded-full" style={{ background: 'radial-gradient(circle, color-mix(in srgb, var(--brand-accent) 12%, transparent) 0%, transparent 70%)' }} />
          <div className="absolute -bottom-20 -left-20 size-[400px] rounded-full" style={{ background: 'radial-gradient(circle, color-mix(in srgb, var(--brand-accent) 6%, transparent) 0%, transparent 70%)' }} />
        </div>

        <div className="relative z-10 max-w-[640px]">
          {/* Tenant tag */}
          <div className="mb-5 inline-flex items-center gap-1.5 rounded-full border border-[var(--brand-accent)]/30 bg-[var(--brand-accent)]/15 px-3.5 py-1.5 text-xs md:text-sm font-semibold text-[var(--brand-accent)]">
            <div className="size-1.5 rounded-full bg-[var(--brand-accent)]" />
            {branding.name} &middot; Bulk Verge Collection
          </div>

          <h1 className="mb-5 font-[family-name:var(--font-heading)] text-4xl md:text-5xl font-bold leading-[1.1] text-white lg:text-[52px]">
            {headline.split('\n').map((line, i) => (
              <span key={i}>
                {i > 0 && <br />}
                {i === 1 ? <span className="text-[var(--brand-accent)]">{line}</span> : line}
              </span>
            ))}
          </h1>

          <p className="mb-10 max-w-[520px] text-base md:text-lg leading-relaxed text-[#C7D3DD] lg:text-lg">
            {subheading}
          </p>

          {/* Search box */}
          <HeroSearch />

          <p className="mt-2.5 text-xs md:text-sm text-[#8FA5B8]">
            e.g. 12 Main Street, Perth WA 6000
          </p>
        </div>
      </section>

      {/* Features */}
      <section className="bg-white px-8 py-[72px] lg:px-20">
        <div className="mx-auto w-full max-w-5xl">
        <div className="mb-3 text-xs md:text-sm font-semibold uppercase tracking-[1px] text-[var(--brand-accent-dark)]">
          Why book online
        </div>
        <h2 className="mb-3 font-[family-name:var(--font-heading)] text-3xl md:text-4xl font-bold text-[var(--brand)] lg:text-4xl">
          Fast, Simple, Paperless
        </h2>
        <p className="mb-14 max-w-[520px] text-base md:text-lg text-gray-500">
          Book your collection from any device in under 3 minutes. No phone
          calls, no paperwork.
        </p>
        <div className="grid gap-8 md:grid-cols-3">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="flex flex-col gap-3">
              <div
                className={`flex size-11 items-center justify-center rounded-xl ${feature.colorClass}`}
              >
                {feature.icon}
              </div>
              <h3 className="font-[family-name:var(--font-heading)] text-base md:text-lg font-semibold text-[var(--brand)]">
                {feature.title}
              </h3>
              <p className="text-sm md:text-base leading-relaxed text-gray-500">
                {feature.body}
              </p>
            </div>
          ))}
        </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="bg-gray-50 px-8 py-[72px] lg:px-20">
        <div className="mx-auto w-full max-w-5xl">
        <h2 className="mb-12 font-[family-name:var(--font-heading)] text-3xl md:text-4xl font-bold text-[var(--brand)] lg:text-4xl">
          How it works
        </h2>
        <div className="relative grid grid-cols-2 gap-y-10 md:grid-cols-5 md:gap-0">
          {/* Connector line (desktop only) */}
          <div className="absolute left-[calc(10%+20px)] right-[calc(10%+20px)] top-5 hidden h-0.5 bg-gray-100 md:block" />
          {STEPS.map((step, i) => (
            <div
              key={step.title}
              className="flex flex-col items-center gap-3.5 px-4"
            >
              <div className="relative z-10 flex size-10 items-center justify-center rounded-full bg-[var(--brand-accent)] font-[family-name:var(--font-heading)] text-base md:text-lg font-bold text-[var(--brand)] shadow-[0_0_0_6px_#F5F5F5]">
                {i + 1}
              </div>
              <h3 className="text-center text-body-sm md:text-body font-semibold text-[var(--brand)]">
                {step.title}
              </h3>
              <p className="text-center text-xs md:text-sm leading-relaxed text-gray-500">
                {step.body}
              </p>
            </div>
          ))}
        </div>
        </div>
      </section>

      {/* What We Collect — dynamic per client. Hide section entirely if
          this client has no enabled services (would otherwise be an empty
          grid with just the info tile). */}
      {services.length > 0 && (
      <section id="services" className="bg-white px-8 py-[72px] lg:px-20">
        <div className="mx-auto w-full max-w-5xl">
        <h2 className="mb-3 font-[family-name:var(--font-heading)] text-3xl md:text-4xl font-bold text-[var(--brand)] lg:text-4xl">
          What We Collect
        </h2>
        <p className="mb-12 text-base md:text-lg text-gray-500">
          Available in {branding.name}. Allocation limits apply per financial
          year.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {services.map((svc) => (
            <div
              key={svc.name}
              className="flex flex-col gap-2 rounded-xl border-[1.5px] border-gray-100 bg-gray-50 px-5 py-5"
            >
              <h3 className="font-[family-name:var(--font-heading)] text-body md:text-subtitle font-semibold text-[var(--brand)]">
                {svc.name}
              </h3>
              <p className="text-body-sm md:text-body text-gray-500">{svc.desc}</p>
              <span
                className={`inline-flex w-fit rounded-full px-2.5 py-0.5 text-[11px] md:text-body-sm font-medium ${svc.tagClass}`}
              >
                {svc.tag}
              </span>
            </div>
          ))}
          {/* Info tile */}
          <div className="flex items-center gap-3.5 rounded-xl border-[1.5px] border-[#C7D3DD] bg-[#E8EEF2] px-5 py-5">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--brand)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <div>
              <h3 className="font-[family-name:var(--font-heading)] text-body md:text-subtitle font-semibold text-[var(--brand)]">
                Not sure what&apos;s eligible?
              </h3>
              <p className="text-xs md:text-sm text-gray-500">
                Check our full guidelines or contact us
              </p>
            </div>
          </div>
        </div>
        </div>
      </section>
      )}

      {/* CTA band */}
      <section className="relative overflow-hidden bg-[var(--brand)] px-8 py-[72px] lg:px-20">
        <div className="absolute -right-24 -top-24 size-[400px] rounded-full" style={{ background: 'radial-gradient(circle, color-mix(in srgb, var(--brand-accent) 10%, transparent) 0%, transparent 70%)' }} />
        <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-col items-start justify-between gap-8 lg:flex-row lg:items-center">
          <div>
            <h2 className="mb-3 font-[family-name:var(--font-heading)] text-3xl md:text-4xl font-bold leading-tight text-white lg:text-4xl">
              Ready to book your
              <br />
              collection?
            </h2>
            <p className="max-w-[480px] text-base md:text-lg leading-relaxed text-[#C7D3DD]">
              Enter your address to check eligibility and book in under 3
              minutes. Your annual allocation is waiting.
            </p>
          </div>
          <Link
            href="/book"
            className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-[var(--brand-accent)] px-9 py-4 font-[family-name:var(--font-heading)] text-base md:text-lg font-bold text-[var(--brand)]"
          >
            Book a Collection
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="flex flex-col items-center justify-between gap-4 bg-[var(--brand-hover)] px-8 py-8 sm:flex-row lg:px-20">
        <div className="flex items-center gap-3">
          {branding.logo_light_url ? (
            <img src={branding.logo_light_url} alt={branding.name} className="h-6 w-auto" />
          ) : (
            <div className="flex size-6 items-center justify-center rounded-md bg-[var(--brand-accent)] font-[family-name:var(--font-heading)] text-body-sm md:text-body font-bold text-[var(--brand)]">
              V
            </div>
          )}
          <span className="text-body-sm md:text-body text-[#8FA5B8]">
            &copy; {new Date().getFullYear()} {branding.name}
            {branding.privacy_policy_url && (
              <>
                {' '}
                &middot;{' '}
                <a
                  href={branding.privacy_policy_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#8FA5B8] underline"
                >
                  Privacy Policy
                </a>
              </>
            )}
          </span>
        </div>
        {branding.show_powered_by && (
          <div className="flex items-center gap-1.5 text-xs md:text-sm text-[#8FA5B8]">
            Booking platform powered by
            <span className="rounded border border-white/[0.12] bg-white/[0.08] px-2 py-0.5 font-[family-name:var(--font-heading)] text-[11px] md:text-body-sm font-semibold text-white">
              VERCO
            </span>
          </div>
        )}
      </footer>
    </div>
  )
}
