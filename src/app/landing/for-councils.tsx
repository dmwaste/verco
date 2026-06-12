const VALUE_PROPS = [
  {
    title: 'White-label resident portal',
    body: 'Your branding, your domain, your service rules. Residents book against the entitlements you set — never a generic third-party form.',
  },
  {
    title: 'Capacity-managed scheduling',
    body: 'Daily collection capacity is enforced at booking time, so runs stay deliverable and residents only see dates you can actually service.',
  },
  {
    title: 'Field crew app and evidence',
    body: 'Crews work from a live run sheet with per-stop closeout, photos, and non-conformance records — every collection accounted for.',
  },
  {
    title: 'Reporting your team can stand behind',
    body: 'Bookings, completions, exceptions, and notice histories in one place, scoped to your council and exportable when you need it.',
  },
] as const

/**
 * The council-evaluator section: claims backed by evidence — a real
 * screenshot of the live Kwinana booking flow (white-label proof) and the
 * "Live with" line. "Live with", never "Trusted by": government clients
 * resist endorsement framing.
 *
 * mailto is backed by visible selectable text — locked-down council SOE
 * machines silently no-op mailto links.
 */
export function ForCouncils() {
  return (
    <section
      id="councils"
      className="scroll-mt-6 bg-[#293F52] px-6 py-16 text-white sm:py-24"
    >
      <div className="mx-auto max-w-6xl">
        <div className="grid items-start gap-12 lg:grid-cols-[1fr_minmax(260px,320px)]">
          <div>
            <p className="text-[13px] font-semibold uppercase tracking-wider text-[#00E47C]">
              For councils
            </p>
            <h2 className="mt-3 font-[family-name:var(--font-heading)] text-[clamp(1.5rem,2.5vw,2rem)] font-semibold text-white">
              Run your verge collection service on Verco
            </h2>

            <dl className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2">
              {VALUE_PROPS.map((prop) => (
                <div
                  key={prop.title}
                  className="border-l-2 border-[#00E47C] pl-4"
                >
                  <dt className="font-[family-name:var(--font-heading)] text-[17px] font-semibold text-white">
                    {prop.title}
                  </dt>
                  <dd className="mt-2 text-[15px] leading-relaxed text-white/80">
                    {prop.body}
                  </dd>
                </div>
              ))}
            </dl>

            <div className="mt-12">
              <p className="text-[15px] text-white/70">
                Live with WMRC&apos;s Verge Valet and the City of Kwinana.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-4">
                <span className="inline-flex h-20 items-center rounded-xl bg-white px-6">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/landing/logo-vergevalet.png"
                    alt="Verge Valet"
                    width={600}
                    height={168}
                    className="h-12 w-auto"
                  />
                </span>
                <span className="inline-flex h-20 items-center rounded-xl bg-white px-6">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/landing/logo-kwinana.png"
                    alt="City of Kwinana"
                    width={600}
                    height={366}
                    className="h-14 w-auto"
                  />
                </span>
              </div>
            </div>

            <div className="mt-12 flex flex-wrap items-center gap-x-4 gap-y-3">
              <a
                href="mailto:bookings@verco.au?subject=Verge%20collection%20on%20Verco"
                className="inline-flex h-12 items-center justify-center rounded-xl bg-[#00E47C] px-6 font-[family-name:var(--font-heading)] font-semibold transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                style={{ color: '#293F52' }}
              >
                Talk to us
              </a>
              <span className="select-all text-[15px] text-white/80">
                bookings@verco.au
              </span>
            </div>
          </div>

          <figure className="mx-auto w-full max-w-[300px] lg:mx-0">
            <div className="overflow-hidden rounded-2xl ring-1 ring-white/20">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/landing/product-booking.png"
                alt="The resident booking flow on the City of Kwinana's Verco site"
                width={1170}
                height={1560}
                className="w-full"
                loading="lazy"
                decoding="async"
              />
            </div>
            <figcaption className="mt-3 text-center text-[13px] text-white/60">
              The resident booking flow, live on the City of Kwinana&apos;s
              site.
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  )
}
