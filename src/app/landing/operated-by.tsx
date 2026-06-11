import { DmLogo } from './logos'

/** Operator credibility band + page footer. */
export function OperatedBy() {
  return (
    <>
      <section className="bg-white px-6 py-16 sm:py-24">
        <div className="mx-auto flex max-w-6xl flex-col items-start gap-8 sm:flex-row sm:items-center sm:gap-12">
          <DmLogo className="h-14 w-auto shrink-0 sm:h-16" />
          <div>
            <p className="max-w-2xl text-[16px] leading-relaxed text-gray-700">
              Verco is built and operated by D&amp;M Waste Management, a
              Western Australian bulk waste contractor delivering verge
              collection programs across Perth and regional WA. Every booking
              made on Verco is collected by D&amp;M&apos;s own crews and
              equipment — one accountable operator from booking to verge.
            </p>
            <p className="mt-4 text-[15px] font-semibold text-[#293F52]">
              Daniel Taylor
              <span className="font-normal text-gray-500">
                {' '}
                — Managing Director
              </span>
            </p>
          </div>
        </div>
      </section>

      <footer className="border-t border-gray-100 bg-white px-6 py-6 text-center text-xs text-gray-400">
        <p>
          Verco is operated by D&amp;M Waste Management. Verge collection
          services are delivered on behalf of each participating council.
        </p>
      </footer>
    </>
  )
}
