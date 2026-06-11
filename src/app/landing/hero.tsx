/**
 * Full-bleed hero over the 2018 D&M aerial collection photo.
 *
 * Geometry per the approved design spec: min 75svh mobile / 70svh desktop,
 * capped at 780px so ultrawide screens still show the council picker peeking
 * above the fold (premise: resident routing stays ≤1 scroll). Pre-sized
 * <img srcset> from committed assets — deliberately NOT next/image; the
 * optimizer has never run in this deployment and the front door is the wrong
 * place for its debut.
 *
 * object-position biases right-of-centre so the rear-loader working the
 * verge survives portrait crops (the photo's credibility moment).
 */
export function Hero() {
  return (
    <section className="relative flex min-h-[75svh] flex-col justify-end overflow-hidden lg:min-h-[70svh] lg:max-h-[780px]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/landing/hero-2000.jpg"
        srcSet="/landing/hero-1200.jpg 1200w, /landing/hero-2000.jpg 2000w"
        sizes="100vw"
        width={2000}
        height={1599}
        alt="Aerial view of a D&M Waste Management crew collecting green waste from residential verges"
        className="absolute inset-0 h-full w-full object-cover"
        style={{ objectPosition: '58% 45%' }}
        fetchPriority="high"
        decoding="async"
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(to top, rgba(41,63,82,.92), rgba(41,63,82,.45) 55%, rgba(41,63,82,.2))',
        }}
        aria-hidden="true"
      />

      <div className="relative mx-auto w-full max-w-6xl px-6 pb-14 pt-28 sm:pb-16">
        <h1 className="max-w-3xl font-[family-name:var(--font-heading)] text-[clamp(2.25rem,4.5vw,3.5rem)] font-bold leading-[1.1] text-white">
          Bulk verge collection, booked online in minutes.
        </h1>
        <p className="mt-5 max-w-2xl text-[17px] leading-relaxed text-white/90">
          Verco is the booking platform behind pre-booked verge collection for
          WA councils including WMRC&apos;s Verge Valet and the City of
          Kwinana — white-labelled for your community and delivered end-to-end
          by D&amp;M Waste Management&apos;s own crews.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <a
            href="#book"
            className="inline-flex h-12 items-center justify-center rounded-xl bg-[#00E47C] px-6 font-[family-name:var(--font-heading)] font-semibold text-[#293F52] transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            style={{ color: '#293F52' }}
          >
            Book a collection
          </a>
          <a
            href="#councils"
            className="inline-flex h-12 items-center justify-center rounded-xl border-[1.5px] border-white px-6 font-[family-name:var(--font-heading)] font-semibold text-white transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            style={{ color: '#FFFFFF' }}
          >
            Partner with us
          </a>
        </div>
      </div>
    </section>
  )
}
