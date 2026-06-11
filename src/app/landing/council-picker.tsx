import type { PickerState } from './picker-state'
import { formatServingLine } from './serving-line'

/**
 * DB-driven tenant cards. One action per card — "Book a collection" in the
 * tenant's accent. (The old per-card "Staff sign in" gave the page's smallest
 * audience half of every card's action area; staff have the header link.)
 *
 * Logo slot: both prod logo_light_url assets are light/reversed variants
 * (verified 2026-06-11 — KWN SVG is fill:#fff, VV PNG averages 255/255
 * brightness), so logos render on a chip filled with the tenant's
 * primary_colour — the ground those assets were designed for. Fixed-height
 * container kills layout shift from unknown DB image dimensions.
 */
export function CouncilPicker({ state }: { state: PickerState }) {
  return (
    <section id="book" className="scroll-mt-6 bg-gray-50 px-6 py-16 sm:py-24">
      <div className="mx-auto max-w-6xl">
        <h2 className="font-[family-name:var(--font-heading)] text-[clamp(1.5rem,2.5vw,2rem)] font-semibold text-[#293F52]">
          Find your council to get started
        </h2>
        <p className="mt-2 max-w-2xl text-[16px] text-gray-600">
          Booking and managing your collection happens on your council&apos;s
          own Verco site.
        </p>

        {state.kind === 'unavailable' && (
          <p className="mt-8 rounded-2xl bg-white px-5 py-8 text-center text-[15px] text-gray-500 ring-1 ring-gray-200">
            The council list is temporarily unavailable — try again shortly,
            or email{' '}
            <a
              href="mailto:bookings@verco.au"
              className="font-semibold text-[#293F52] underline underline-offset-2"
            >
              bookings@verco.au
            </a>
            .
          </p>
        )}

        {state.kind === 'none-live' && (
          <p className="mt-8 rounded-2xl bg-white px-5 py-8 text-center text-[15px] text-gray-500 ring-1 ring-gray-200">
            No councils are live on Verco just yet. Check back soon.
          </p>
        )}

        {state.kind === 'cards' && (
          <>
            <div className="mt-8 grid gap-5 sm:grid-cols-2">
              {state.clients.map((c) => {
                const accent = c.accent_colour ?? '#00E47C'
                const primary = c.primary_colour ?? '#293F52'
                const serving = formatServingLine(c.subClients)

                return (
                  <div
                    key={c.slug}
                    className="flex flex-col rounded-2xl bg-white p-6 ring-1 ring-gray-200"
                  >
                    <div className="mb-5 flex items-center gap-4">
                      {c.logo_light_url ? (
                        <span
                          className="inline-flex h-12 max-w-[160px] shrink-0 items-center rounded-lg px-3"
                          style={{ backgroundColor: primary }}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          {/* Explicit height (not max-height): SVG logos
                              without width/height attrs collapse to 0 under
                              max-height alone — no basis for auto width. */}
                          <img
                            src={c.logo_light_url}
                            alt=""
                            className="h-8 w-auto max-w-[130px] object-contain object-left"
                          />
                        </span>
                      ) : (
                        <span
                          className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-lg font-[family-name:var(--font-heading)] text-lg font-semibold"
                          style={{ backgroundColor: primary, color: '#FFFFFF' }}
                        >
                          {c.name.charAt(0)}
                        </span>
                      )}
                      <div>
                        <div className="font-[family-name:var(--font-heading)] text-[17px] font-semibold text-[#293F52]">
                          {c.name}
                        </div>
                        {c.service_name && (
                          <div className="text-[13px] text-gray-500">
                            {c.service_name}
                          </div>
                        )}
                      </div>
                    </div>

                    {serving && (
                      <p className="mb-5 text-[13px] leading-snug text-gray-500">
                        {serving}
                      </p>
                    )}

                    <a
                      href={`https://${c.custom_domain}`}
                      className="mt-auto inline-flex h-12 w-full items-center justify-center rounded-xl px-4 font-[family-name:var(--font-heading)] font-semibold transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#293F52]"
                      style={{ backgroundColor: accent, color: '#293F52' }}
                    >
                      Book a collection
                    </a>
                  </div>
                )
              })}
            </div>
            <p className="mt-6 text-[14px] text-gray-500">
              Verco currently runs verge collection bookings for the councils
              above. If yours isn&apos;t listed, check your council&apos;s
              website for verge collection options.
            </p>
          </>
        )}
      </div>
    </section>
  )
}
