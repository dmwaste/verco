'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { submitSurvey, type SurveyResponses } from './actions'
import { ThankYou } from './thank-you'
import { VercoButton } from '@/components/ui/verco-button'
import { cn } from '@/lib/utils'

interface ServiceChip {
  name: string
  qty: number
  isExtra: boolean
}

interface SurveyFormProps {
  token: string
  bookingRef: string
  collectionDate: string
  serviceChips: ServiceChip[]
}

const REPAIR_OPTIONS = [
  'Yes — attempted repair',
  'Yes — donated or gave away',
  'No',
  'Not applicable',
]

const SELL_OPTIONS = [
  'Yes — sold online (e.g. Facebook Marketplace)',
  'Yes — gave to family/friends',
  'No',
  'Not applicable',
]

const PREFER_OPTIONS = ['Yes', 'No', 'Indifferent'] as const

function StarRating({
  value,
  onChange,
  label,
}: {
  value: number
  onChange: (v: number) => void
  label: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1.5">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            onClick={() => onChange(star)}
            className="size-9"
          >
            <svg viewBox="0 0 24 24" className="size-9">
              <path
                d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                fill={star <= value ? '#FF8C42' : '#E8E8E8'}
                stroke={star <= value ? '#FF8C42' : '#E8E8E8'}
                strokeWidth="1.5"
              />
            </svg>
          </button>
        ))}
      </div>
      <span className="text-caption text-gray-500">
        {value > 0 ? `${value} out of 5 stars` : label}
      </span>
    </div>
  )
}

export function SurveyForm({
  token,
  bookingRef,
  collectionDate,
  serviceChips,
}: SurveyFormProps) {
  const router = useRouter()

  // Section 1: About Your Collection
  const [attemptedRepair, setAttemptedRepair] = useState('')
  const [attemptedSell, setAttemptedSell] = useState('')

  // Section 2: Booking Feedback
  const [bookingRating, setBookingRating] = useState(0)
  const [bookingComments, setBookingComments] = useState('')

  // Section 3: Collection Feedback
  const [collectionRating, setCollectionRating] = useState(0)
  const [collectionComments, setCollectionComments] = useState('')

  // Section 4: Overall Feedback
  const [overallRating, setOverallRating] = useState(0)
  const [preferService, setPreferService] = useState('')
  const [otherComments, setOtherComments] = useState('')

  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  // Track section completion
  const section1Done = attemptedRepair !== '' && attemptedSell !== ''
  const section2Done = bookingRating > 0
  const section3Done = collectionRating > 0
  const sectionsCompleted =
    (section1Done ? 1 : 0) + (section2Done ? 1 : 0) + (section3Done ? 1 : 0)
  const progressPct = (sectionsCompleted / 3) * 100

  // Determine active section
  const activeSection = !section1Done ? 1 : !section2Done ? 2 : !section3Done ? 3 : 4

  const formattedDate = collectionDate
    ? format(new Date(collectionDate + 'T00:00:00'), 'EEE d MMMM yyyy')
    : ''

  async function handleSubmit() {
    if (bookingRating === 0 || collectionRating === 0 || overallRating === 0) {
      setError('Please complete all star ratings before submitting.')
      return
    }

    setIsSubmitting(true)
    setError(null)

    const responses: SurveyResponses = {
      attempted_repair: attemptedRepair,
      attempted_sell: attemptedSell,
      booking_rating: bookingRating,
      booking_comments: bookingComments,
      collection_rating: collectionRating,
      collection_comments: collectionComments,
      overall_rating: overallRating,
      prefer_service: preferService,
      other_comments: otherComments,
    }

    const result = await submitSurvey(token, responses)

    if (!result.ok) {
      setError(result.error)
      setIsSubmitting(false)
      return
    }

    setSubmitted(true)
  }

  if (submitted) {
    return (
      <ThankYou
        bookingRef={bookingRef}
        responses={{
          booking_rating: bookingRating,
          collection_rating: collectionRating,
          overall_rating: overallRating,
          attempted_repair: attemptedRepair,
          attempted_sell: attemptedSell,
          booking_comments: bookingComments,
          collection_comments: collectionComments,
          prefer_service: preferService,
          other_comments: otherComments,
        }}
      />
    )
  }

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="shrink-0 bg-[var(--brand)] px-5 pb-5 pt-4 sm:mt-6 sm:rounded-xl">
        <div className="mb-2.5 flex items-center gap-2">
          <div className="flex size-[26px] items-center justify-center rounded-[6px] bg-[var(--brand-accent)] font-[family-name:var(--font-heading)] text-sm font-bold text-[var(--brand)]">
            V
          </div>
          <span className="font-[family-name:var(--font-heading)] text-body font-bold text-white">
            Verge Collection
          </span>
        </div>
        <h1 className="mb-1 font-[family-name:var(--font-heading)] text-lg font-bold text-white">
          Customer Satisfaction Survey
        </h1>
        <p className="text-xs leading-snug text-[#8FA5B8]">
          Thank you for using the Verge Collection service. Your feedback helps
          us improve.
        </p>
        <div className="mt-3 flex items-center justify-between rounded-lg bg-white/[0.08] px-3 py-2">
          <span className="text-caption text-[#8FA5B8]">Booking reference</span>
          <span className="font-[family-name:var(--font-heading)] text-xs font-semibold text-white">
            {bookingRef}
          </span>
        </div>
      </div>

      {/* Progress */}
      <div className="bg-white px-5 pb-3 pt-3">
        <div className="flex justify-between text-caption text-gray-500">
          <span>Survey progress</span>
          <span>{sectionsCompleted} of 3 sections</span>
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-gray-100">
          <div
            className="h-full rounded-full bg-[var(--brand-accent-dark)] transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col gap-3.5 px-5 pb-24 pt-4">
        {/* Section 1: About Your Collection */}
        <div
          className={cn(
            'flex flex-col gap-3.5 rounded-xl bg-white p-4 shadow-sm',
            section1Done && activeSection > 1 && 'opacity-60',
            activeSection === 1 && 'border-2 border-[var(--brand)]'
          )}
        >
          <div className="flex items-center justify-between">
            <h2 className="font-[family-name:var(--font-heading)] text-sm font-semibold text-[var(--brand)]">
              About Your Collection
            </h2>
            {section1Done && (
              <span className="flex items-center gap-1 text-xs font-medium text-[var(--brand-accent-dark)]">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                Complete
              </span>
            )}
          </div>

          {(activeSection === 1 || !section1Done) && (
            <>
              <div className="border-t border-gray-100 pt-3.5">
                <div className="mb-1.5 text-xs font-medium text-gray-700">
                  Services collected
                </div>
                <div className="flex flex-wrap gap-1.5 rounded-[10px] border-[1.5px] border-gray-100 bg-gray-50 p-2.5">
                  {serviceChips.map((chip, i) => (
                    <span
                      key={i}
                      className={cn(
                        'inline-flex rounded-full px-2.5 py-1 text-xs font-medium',
                        chip.isExtra
                          ? 'bg-[#FFF3EA] text-[#8B4000]'
                          : 'bg-[#E8EEF2] text-[var(--brand)]'
                      )}
                    >
                      {chip.name} &times; {chip.qty}
                      {chip.isExtra && ' (extra)'}
                    </span>
                  ))}
                </div>
                <div className="mt-1 text-caption text-gray-500">
                  From booking {bookingRef}
                  {formattedDate && ` · ${formattedDate}`}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-gray-700">
                  Did you attempt to repair or donate items before booking?
                </label>
                <select
                  value={attemptedRepair}
                  onChange={(e) => setAttemptedRepair(e.target.value)}
                  className={cn(
                    'w-full appearance-none rounded-[10px] border-[1.5px] border-gray-100 bg-gray-50 px-3.5 py-2.5 text-sm outline-none',
                    !attemptedRepair ? 'text-gray-300' : 'text-gray-900'
                  )}
                >
                  <option value="" disabled>
                    Select an option...
                  </option>
                  {REPAIR_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-gray-700">
                  Did you attempt to sell or rehome items before booking?
                </label>
                <select
                  value={attemptedSell}
                  onChange={(e) => setAttemptedSell(e.target.value)}
                  className={cn(
                    'w-full appearance-none rounded-[10px] border-[1.5px] border-gray-100 bg-gray-50 px-3.5 py-2.5 text-sm outline-none',
                    !attemptedSell ? 'text-gray-300' : 'text-gray-900'
                  )}
                >
                  <option value="" disabled>
                    Select an option...
                  </option>
                  {SELL_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
        </div>

        {/* Section 2: Booking Feedback */}
        <div
          className={cn(
            'flex flex-col gap-3.5 rounded-xl bg-white p-4 shadow-sm',
            section2Done && activeSection > 2 && 'opacity-60',
            activeSection === 2 && 'border-2 border-[var(--brand)]',
            activeSection < 2 && 'opacity-50'
          )}
        >
          <div className="flex items-center justify-between">
            <h2 className="font-[family-name:var(--font-heading)] text-sm font-semibold text-[var(--brand)]">
              Booking Feedback
            </h2>
            {section2Done && (
              <span className="flex items-center gap-1 text-xs font-medium text-[var(--brand-accent-dark)]">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                Complete
              </span>
            )}
          </div>

          {activeSection <= 2 && (
            <>
              <div className="border-t border-gray-100 pt-3.5">
                <div className="mb-1.5 text-xs font-medium text-gray-700">
                  Booking experience rating{' '}
                  <span className="text-[var(--brand-accent-dark)]">*</span>
                </div>
                <StarRating
                  value={bookingRating}
                  onChange={setBookingRating}
                  label="Tap to rate"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-gray-700">
                  Booking comments
                </label>
                <textarea
                  value={bookingComments}
                  onChange={(e) => setBookingComments(e.target.value)}
                  placeholder="Tell us about your booking experience — was it easy to use?"
                  className="h-[76px] w-full resize-none rounded-[10px] border-[1.5px] border-gray-100 bg-gray-50 px-3.5 py-2.5 text-body-sm leading-relaxed text-gray-700 outline-none placeholder:text-gray-300 focus:border-[var(--brand)] focus:bg-white"
                />
              </div>
            </>
          )}
        </div>

        {/* Section 3: Collection Feedback */}
        <div
          className={cn(
            'flex flex-col gap-3.5 rounded-xl bg-white p-4 shadow-sm',
            section3Done && activeSection > 3 && 'opacity-60',
            activeSection === 3 && 'border-2 border-[var(--brand)]',
            activeSection < 3 && 'opacity-50'
          )}
        >
          <div className="flex items-center justify-between">
            <h2 className="font-[family-name:var(--font-heading)] text-sm font-semibold text-[var(--brand)]">
              Collection Feedback
            </h2>
            {section3Done && (
              <span className="flex items-center gap-1 text-xs font-medium text-[var(--brand-accent-dark)]">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                Complete
              </span>
            )}
          </div>

          {activeSection >= 3 ? (
            <>
              <div className="border-t border-gray-100 pt-3.5">
                <div className="mb-1.5 text-xs font-medium text-gray-700">
                  Collection service rating{' '}
                  <span className="text-[var(--brand-accent-dark)]">*</span>
                </div>
                <StarRating
                  value={collectionRating}
                  onChange={setCollectionRating}
                  label="Tap to rate"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-gray-700">
                  Collection comments
                </label>
                <textarea
                  value={collectionComments}
                  onChange={(e) => setCollectionComments(e.target.value)}
                  placeholder="How was the collection itself? Was everything picked up as expected?"
                  className="h-[76px] w-full resize-none rounded-[10px] border-[1.5px] border-gray-100 bg-gray-50 px-3.5 py-2.5 text-body-sm leading-relaxed text-gray-700 outline-none placeholder:text-gray-300 focus:border-[var(--brand)] focus:bg-white"
                />
              </div>
            </>
          ) : (
            <div className="text-xs text-gray-500">
              Complete the previous section to continue.
            </div>
          )}
        </div>

        {/* Section 4: Overall Feedback */}
        <div
          className={cn(
            'flex flex-col gap-3.5 rounded-xl bg-white p-4 shadow-sm',
            activeSection < 4 && 'opacity-50'
          )}
        >
          <h2 className="font-[family-name:var(--font-heading)] text-sm font-semibold text-[var(--brand)]">
            Overall Feedback
          </h2>

          {activeSection >= 4 ? (
            <>
              <div className="border-t border-gray-100 pt-3.5">
                <div className="mb-1.5 text-xs font-medium text-gray-700">
                  Overall rating <span className="text-[var(--brand-accent-dark)]">*</span>
                </div>
                <StarRating
                  value={overallRating}
                  onChange={setOverallRating}
                  label="Tap to rate"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-gray-700">
                  Would you prefer this service over traditional bulk verge
                  collection? <span className="text-[var(--brand-accent-dark)]">*</span>
                </label>
                <div className="flex flex-col gap-2">
                  {PREFER_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setPreferService(opt)}
                      className={cn(
                        'flex items-center gap-2.5 rounded-[10px] border-[1.5px] px-3.5 py-2.5 text-sm font-medium transition-colors',
                        preferService === opt
                          ? 'border-[var(--brand)] bg-[#E8EEF2] text-[var(--brand)]'
                          : 'border-gray-100 bg-white text-gray-700'
                      )}
                    >
                      <div
                        className={cn(
                          'flex size-4 items-center justify-center rounded-full border-[1.5px]',
                          preferService === opt
                            ? 'border-[var(--brand)] bg-[var(--brand)]'
                            : 'border-gray-300'
                        )}
                      >
                        {preferService === opt && (
                          <div className="size-1.5 rounded-full bg-white" />
                        )}
                      </div>
                      {opt}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-gray-700">
                  Any other comments?
                </label>
                <textarea
                  value={otherComments}
                  onChange={(e) => setOtherComments(e.target.value)}
                  placeholder="Anything else you'd like to share about your experience..."
                  className="h-[76px] w-full resize-none rounded-[10px] border-[1.5px] border-gray-100 bg-gray-50 px-3.5 py-2.5 text-body-sm leading-relaxed text-gray-700 outline-none placeholder:text-gray-300 focus:border-[var(--brand)] focus:bg-white"
                />
              </div>
            </>
          ) : (
            <div className="text-xs text-gray-500">
              Complete the previous section to continue.
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700">
            {error}
          </div>
        )}

        <VercoButton type="button" onClick={handleSubmit} disabled={isSubmitting} className="w-full">
          {isSubmitting ? 'Submitting...' : 'Submit Survey'}
        </VercoButton>

        <div className="flex items-center justify-center gap-1.5 pt-4 text-caption text-gray-300">
          Powered by
          <span className="rounded bg-gray-100 px-1.5 py-px font-[family-name:var(--font-heading)] text-2xs font-bold text-gray-500">
            VERCO
          </span>
        </div>
      </div>
    </div>
  )
}
