const STEPS = [
  {
    number: '01',
    title: 'Enter your address',
    body: 'We confirm your property is eligible and show what your council includes in your annual entitlement.',
  },
  {
    number: '02',
    title: 'Choose your items and date',
    body: 'Pick what you’re putting out — general, green waste, mattresses, whitegoods — and a collection date that suits.',
  },
  {
    number: '03',
    title: 'We collect from your verge',
    body: 'Place items out the night before. A D&M crew collects on your booked day and you’re notified along the way.',
  },
] as const

/**
 * Numbered list, deliberately NOT icon cards — the 3-column
 * icon-in-circle card grid is the single most recognisable
 * AI-template layout and this page trades on looking real.
 */
export function HowItWorks() {
  return (
    <section className="bg-white px-6 py-16 sm:py-24">
      <div className="mx-auto max-w-6xl">
        <h2 className="font-[family-name:var(--font-heading)] text-[clamp(1.5rem,2.5vw,2rem)] font-semibold text-[#293F52]">
          How it works
        </h2>
        <ol className="mt-10 grid gap-10 sm:grid-cols-3 sm:gap-8">
          {STEPS.map((step) => (
            <li key={step.number}>
              <div className="font-[family-name:var(--font-heading)] text-2xl font-bold text-[#00E47C]">
                {step.number}
              </div>
              <h3 className="mt-2 font-[family-name:var(--font-heading)] text-[17px] font-semibold text-[#293F52]">
                {step.title}
              </h3>
              <p className="mt-2 text-[15px] leading-relaxed text-gray-600">
                {step.body}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
