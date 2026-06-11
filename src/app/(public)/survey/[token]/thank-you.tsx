'use client'

import { VercoButton } from '@/components/ui/verco-button'
import type { SurveyResponses } from './actions'

interface ThankYouProps {
  bookingRef: string
  responses: SurveyResponses | null
}

function MiniStars({ count }: { count: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <svg key={star} width="14" height="14" viewBox="0 0 24 24">
          <path
            d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
            fill={star <= count ? '#FF8C42' : '#E8E8E8'}
            stroke={star <= count ? '#FF8C42' : '#E8E8E8'}
            strokeWidth="1"
          />
        </svg>
      ))}
    </div>
  )
}

export function ThankYou({ bookingRef, responses }: ThankYouProps) {
  const bookingRating = responses?.booking_rating ?? 0
  const collectionRating = responses?.collection_rating ?? 0
  const overallRating = responses?.overall_rating ?? 0

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
      <div className="flex flex-1 flex-col items-center justify-center px-8 pb-16">
        {/* Success icon */}
        <div className="flex size-[72px] items-center justify-center rounded-full bg-[var(--brand-accent-light)]">
          <svg
            width="36"
            height="36"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--brand-accent-dark)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>

        <h1 className="mt-5 font-[family-name:var(--font-heading)] text-title font-bold text-[var(--brand)]">
          Thank you!
        </h1>
        <p className="mt-2 max-w-[280px] text-center text-sm leading-relaxed text-gray-500">
          Your feedback has been submitted. It helps us improve the Verge
          Collection service for everyone.
        </p>

        {/* Rating summary */}
        {responses && (
          <div className="mt-7 flex w-full max-w-sm flex-col gap-2.5 rounded-xl bg-gray-50 px-5 py-4">
            <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              Your ratings
            </div>
            <div className="flex items-center justify-between">
              <span className="text-body-sm text-gray-700">
                Booking experience
              </span>
              <MiniStars count={bookingRating} />
            </div>
            <div className="h-px bg-gray-100" />
            <div className="flex items-center justify-between">
              <span className="text-body-sm text-gray-700">
                Collection service
              </span>
              <MiniStars count={collectionRating} />
            </div>
            <div className="h-px bg-gray-100" />
            <div className="flex items-center justify-between">
              <span className="text-body-sm text-gray-700">Overall</span>
              <MiniStars count={overallRating} />
            </div>
          </div>
        )}

        <VercoButton
          href="/dashboard"
          variant="accent"
          className="mt-7 w-full max-w-[280px]"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
          Back to Dashboard
        </VercoButton>

        <div className="mt-4 text-center text-xs text-gray-400">
          Booking {bookingRef}
        </div>

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
