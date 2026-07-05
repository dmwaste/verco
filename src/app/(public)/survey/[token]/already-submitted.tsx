'use client'

import { VercoButton } from '@/components/ui/verco-button'
import { SurveyBrandHeader } from './survey-brand-header'

export function AlreadySubmitted({
  serviceName,
  logoUrl,
}: {
  serviceName: string
  logoUrl: string | null
}) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      {/* Header */}
      <div className="shrink-0 bg-[var(--brand)] px-5 pb-5 pt-4">
        <SurveyBrandHeader serviceName={serviceName} logoUrl={logoUrl} />
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col items-center justify-center px-8 pb-16 text-center">
        {/* Lock icon */}
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
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>

        <h1 className="mb-2 font-[family-name:var(--font-heading)] text-xl font-bold text-[var(--brand)]">
          Survey already submitted
        </h1>
        <p className="max-w-[280px] text-sm leading-relaxed text-gray-500">
          You&apos;ve already submitted feedback for this booking. Thank you for
          your response.
        </p>

        <VercoButton href="/dashboard" className="mt-8 w-full max-w-[280px]">
          Back to Dashboard
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
