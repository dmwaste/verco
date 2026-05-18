import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

/**
 * Marketing-stub landing served on `verco.au/`. Lets a council partner pick
 * their tenant; resident booking + admin sign-in both link out to the
 * tenant-specific subdomain.
 *
 * Gated by the `x-verco-root` header — without it (e.g. someone navigating
 * to `vvtest.verco.au/landing` directly) the page 404s instead of leaking
 * the root surface from a tenant host. Set by the proxy when rewriting
 * `verco.au/` to `/landing`.
 */
export default async function LandingPage() {
  const h = await headers()
  if (h.get('x-verco-root') !== '1') notFound()

  const supabase = await createClient()
  const { data: clients } = await supabase
    .from('client')
    .select(
      'slug, name, custom_domain, service_name, primary_colour, accent_colour, logo_light_url',
    )
    .eq('is_active', true)
    .not('custom_domain', 'is', null)
    .order('name')

  return (
    <main className="flex min-h-full flex-col">
      <header className="bg-[#293F52] px-6 py-10 text-white sm:px-12 sm:py-14">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-baseline gap-2">
            <span className="font-[family-name:var(--font-poppins)] text-3xl font-bold tracking-tight">
              Verco
            </span>
            <span className="text-sm text-white/60">
              the booking platform
            </span>
          </div>
          <h1 className="mt-6 max-w-2xl font-[family-name:var(--font-poppins)] text-2xl font-semibold leading-tight sm:text-3xl">
            Residential verge collection bookings, operated for your council.
          </h1>
        </div>
      </header>

      <section className="flex-1 bg-gray-50 px-6 py-12 sm:px-12">
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-6 font-[family-name:var(--font-poppins)] text-base font-semibold text-[#293F52]">
            Choose your council
          </h2>

          {(!clients || clients.length === 0) && (
            <p className="rounded-xl bg-white px-5 py-8 text-center text-sm text-gray-500 shadow-sm">
              No councils are currently configured. Check back soon.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            {(clients ?? []).map((c) => {
              const tenantUrl = `https://${c.custom_domain}`
              const adminUrl = `${tenantUrl}/admin`
              const accent = c.accent_colour ?? '#00E47C'
              const primary = c.primary_colour ?? '#293F52'

              return (
                <div
                  key={c.slug}
                  className="flex flex-col rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-100"
                >
                  <div className="mb-4 flex items-center gap-3">
                    {c.logo_light_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={c.logo_light_url}
                        alt=""
                        className="h-10 w-10 rounded-full object-cover"
                      />
                    ) : (
                      <div
                        className="flex h-10 w-10 items-center justify-center rounded-full font-[family-name:var(--font-poppins)] text-base font-semibold text-white"
                        style={{ backgroundColor: primary }}
                      >
                        {c.name.charAt(0)}
                      </div>
                    )}
                    <div>
                      <div className="font-[family-name:var(--font-poppins)] text-base font-semibold text-[#293F52]">
                        {c.name}
                      </div>
                      {c.service_name && (
                        <div className="text-xs text-gray-500">
                          {c.service_name}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-auto flex flex-col gap-2 sm:flex-row">
                    <a
                      href={tenantUrl}
                      className="flex-1 rounded-lg px-4 py-2.5 text-center text-sm font-semibold text-[#293F52] transition-opacity hover:opacity-90"
                      style={{ backgroundColor: accent }}
                    >
                      Book a collection
                    </a>
                    <a
                      href={adminUrl}
                      className="flex-1 rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-center text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                    >
                      Staff sign in
                    </a>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      <footer className="bg-white px-6 py-6 text-center text-xs text-gray-400 sm:px-12">
        <p>
          Verco is operated by D&amp;M Waste Management. Verge collection services are
          delivered on behalf of each participating council.
        </p>
      </footer>
    </main>
  )
}
