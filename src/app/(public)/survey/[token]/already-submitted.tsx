'use client'

import Link from 'next/link'

export function AlreadySubmitted() {
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

        <Link
          href="/dashboard"
          className="mt-8 flex w-full max-w-[280px] items-center justify-center rounded-xl bg-[var(--brand)] px-3.5 py-3.5 font-[family-name:var(--font-heading)] text-body font-semibold text-white"
        >
          Back to Dashboard
        </Link>

        <div className="mt-6 flex items-center justify-center gap-1.5 text-[11px] text-gray-300">
          Powered by
          <span className="rounded bg-gray-100 px-1.5 py-px font-[family-name:var(--font-heading)] text-2xs font-bold text-gray-500">
            VERCO
          </span>
        </div>
      </div>
    </div>
  )
}
