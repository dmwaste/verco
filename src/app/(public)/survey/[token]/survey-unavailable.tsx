'use client'

import { VercoButton } from '@/components/ui/verco-button'

/**
 * Shown when the get_survey_by_token RPC fails (transport/DB error) rather than
 * returning a clean "unknown token". The link may be perfectly valid, so we
 * offer a retry instead of a 404 — a single slow request on 4G must not turn an
 * emailed survey link into a dead end.
 */
export function SurveyUnavailable() {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      {/* Header */}
      <div className="shrink-0 bg-[var(--brand)] px-5 pb-5 pt-4">
        <div className="flex items-center gap-2">
          <div className="flex size-[26px] items-center justify-center rounded-[6px] bg-[var(--brand-accent)] font-[family-name:var(--font-heading)] text-sm font-bold text-[var(--brand)]">
            V
          </div>
          <span className="font-[family-name:var(--font-heading)] text-body font-bold text-white">
            Verge Collection
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col items-center justify-center px-8 pb-16 text-center">
        <div className="mb-5 flex size-16 items-center justify-center rounded-full bg-gray-100">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#7A7A7A"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
        </div>

        <h1 className="mb-2 font-[family-name:var(--font-heading)] text-xl font-bold text-[var(--brand)]">
          Couldn&apos;t load your survey
        </h1>
        <p className="max-w-[280px] text-sm leading-relaxed text-gray-500">
          Something went wrong loading your survey. Your link is still valid —
          please try again.
        </p>

        <VercoButton
          type="button"
          onClick={() => window.location.reload()}
          className="mt-8 w-full max-w-[280px]"
        >
          Try again
        </VercoButton>

        <div className="mt-6 flex items-center justify-center gap-1.5 text-caption text-gray-300">
          Powered by
          <span className="rounded bg-gray-100 px-1.5 py-px font-[family-name:var(--font-heading)] text-2xs font-bold text-gray-500">
            VERCO
          </span>
        </div>
      </div>
    </div>
  )
}
