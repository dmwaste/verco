/**
 * Shown when a /b/<ref> SMS link failed to resolve (unknown ref, inactive
 * tenant, OR unset custom_domain — three causes, so the copy never asserts
 * "expired"). Amber, not brand green: green reads success and this is a
 * soft failure. Rendered between the header and the hero — reassurance must
 * not sit on top of a marketing photo.
 */
export function RecoveryBanner() {
  return (
    <div className="border-b border-[#F0E2C4] bg-[#FFF7E8] px-6">
      <div className="mx-auto flex max-w-6xl items-start gap-3 py-3.5">
        <svg
          viewBox="0 0 20 20"
          className="mt-0.5 h-5 w-5 shrink-0"
          fill="#293F52"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm0-11.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm-1 2.5a1 1 0 0 1 2 0v5a1 1 0 1 1-2 0V9Z"
            clipRule="evenodd"
          />
        </svg>
        <p className="text-[15px] leading-snug text-[#293F52]">
          We couldn&apos;t open that booking link —{' '}
          <a href="#book" className="font-semibold underline underline-offset-2">
            find your council below
          </a>
          ; you can book or manage your collection from your council&apos;s
          site.
        </p>
      </div>
    </div>
  )
}
