'use client'

import Link from 'next/link'
import { format } from 'date-fns'
import { VercoButton } from '@/components/ui/verco-button'

interface ConfirmationProps {
  bookingRef: string
  geoAddress: string
  wasteTypes: string[]
  volume: string
  collectionDate: string
}

export function Confirmation({
  bookingRef,
  geoAddress,
  wasteTypes,
  volume,
  collectionDate,
}: ConfirmationProps) {
  const formattedDate = collectionDate
    ? format(new Date(collectionDate + 'T00:00:00'), 'EEE d MMMM yyyy')
    : ''

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-7 pb-16">
      {/* Success icon */}
      <div className="flex size-16 items-center justify-center rounded-full bg-[var(--brand-accent-light)]">
        <svg
          width="32"
          height="32"
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

      <h1 className="mt-5 font-[family-name:var(--font-heading)] text-xl font-bold text-[var(--brand)]">
        ID Collection Logged
      </h1>
      <p className="mt-1.5 text-center text-body-sm leading-relaxed text-gray-500">
        The booking has been submitted and will appear on the run sheet for{' '}
        {formattedDate}.
      </p>

      {/* Summary card */}
      <div className="mt-6 flex w-full flex-col gap-2 rounded-xl bg-white shadow-sm px-4 py-3.5">
        <div className="flex items-center justify-between border-b border-gray-100 py-1.5 text-body-sm">
          <span className="text-xs text-gray-500">Booking ref</span>
          <span className="font-[family-name:var(--font-heading)] font-semibold text-[var(--brand)]">
            {bookingRef}
          </span>
        </div>
        <div className="flex items-center justify-between border-b border-gray-100 py-1.5 text-body-sm">
          <span className="text-xs text-gray-500">Location</span>
          <span className="max-w-[200px] text-right font-medium text-gray-900">
            {geoAddress}
          </span>
        </div>
        <div className="flex items-center justify-between border-b border-gray-100 py-1.5 text-body-sm">
          <span className="text-xs text-gray-500">Waste type</span>
          <span className="font-medium text-gray-900">
            {wasteTypes.join(', ')}
          </span>
        </div>
        <div className="flex items-center justify-between border-b border-gray-100 py-1.5 text-body-sm">
          <span className="text-xs text-gray-500">Volume</span>
          <span className="font-medium text-gray-900">{volume}</span>
        </div>
        <div className="flex items-center justify-between py-1.5 text-body-sm">
          <span className="text-xs text-gray-500">Collection date</span>
          <span className="font-medium text-[var(--brand)]">{formattedDate}</span>
        </div>
      </div>

      {/* Action buttons */}
      <div className="mt-6 flex w-full flex-col gap-2">
        <VercoButton href="/field/run-sheet" className="w-full">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
            <rect x="8" y="2" width="8" height="4" rx="1" />
          </svg>
          Back to Run Sheet
        </VercoButton>
        <Link
          href="/field/illegal-dumping/new"
          className="flex w-full items-center justify-center rounded-xl border-[1.5px] border-gray-100 bg-white px-3.5 py-3.5 font-[family-name:var(--font-heading)] text-sm font-semibold text-[var(--brand)]"
        >
          Log Another ID Collection
        </Link>
      </div>
    </div>
  )
}
