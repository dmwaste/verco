'use client'

import { useSearchParams, useRouter } from 'next/navigation'
import { useState } from 'react'
import Link from 'next/link'
import { BookingStepper } from '@/components/booking/booking-stepper'
import { BookingCancelLink } from '@/components/booking/booking-cancel-link'
import { VercoButton } from '@/components/ui/verco-button'
import {
  LOCATION_OPTIONS,
  STAFF_LOCATION_OPTION,
  type LocationOption,
} from '@/lib/booking/schemas'
import { cn } from '@/lib/utils'

export function DetailsForm({ contactPhone }: { contactPhone: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const propertyId = searchParams.get('property_id') ?? ''
  const collectionAreaId = searchParams.get('collection_area_id') ?? ''
  const address = searchParams.get('address') ?? ''
  const itemsParam = searchParams.get('items') ?? ''
  const totalCents = searchParams.get('total_cents') ?? '0'
  const collectionDateId = searchParams.get('collection_date_id') ?? ''
  const onBehalf = searchParams.get('on_behalf') === 'true'

  const [location, setLocation] = useState<LocationOption>(
    (searchParams.get('location') as LocationOption) ?? 'Front Verge'
  )
  const [notes, setNotes] = useState(searchParams.get('notes') ?? '')

  // 'Other' is staff-only — surfaced only in the on-behalf flow — and forces
  // the driver notes to be filled in (free-text location needs explanation).
  const locationOptions = onBehalf
    ? [...LOCATION_OPTIONS, STAFF_LOCATION_OPTION]
    : LOCATION_OPTIONS
  const notesRequired = location === STAFF_LOCATION_OPTION
  const notesMissing = notesRequired && notes.trim().length === 0

  // Carry params through for edit flow
  const contactFirstName = searchParams.get('contact_first_name')
  const contactLastName = searchParams.get('contact_last_name')
  const contactEmail = searchParams.get('contact_email')
  const contactMobile = searchParams.get('contact_mobile')
  const returnUrl = searchParams.get('return_url')
  const replaces = searchParams.get('replaces')
  const carryParams = {
    ...(contactFirstName ? { contact_first_name: contactFirstName } : {}),
    ...(contactLastName ? { contact_last_name: contactLastName } : {}),
    ...(contactEmail ? { contact_email: contactEmail } : {}),
    ...(contactMobile ? { contact_mobile: contactMobile } : {}),
    ...(returnUrl ? { return_url: returnUrl } : {}),
    ...(replaces ? { replaces } : {}),
  }

  function handleContinue() {
    if (notesMissing) return
    const params = new URLSearchParams({
      property_id: propertyId,
      collection_area_id: collectionAreaId,
      address,
      items: itemsParam,
      total_cents: totalCents,
      collection_date_id: collectionDateId,
      location,
      ...(notes ? { notes } : {}),
      ...(onBehalf ? { on_behalf: 'true' } : {}),
      ...carryParams,
    })
    router.push(`/book/confirm?${params.toString()}`)
  }

  function handleBack() {
    const params = new URLSearchParams({
      property_id: propertyId,
      collection_area_id: collectionAreaId,
      address,
      items: itemsParam,
      total_cents: totalCents,
      collection_date_id: collectionDateId,
      ...(onBehalf ? { on_behalf: 'true' } : {}),
      ...carryParams,
    })
    router.push(`/book/date?${params.toString()}`)
  }

  return (
    <div className="flex flex-col">
      <BookingStepper currentStep={4} />

      {/* Content */}
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto pb-24 pt-6">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-title font-bold leading-tight text-[var(--brand)]">
            Collection details
          </h1>
          <p className="mt-1 text-body-sm leading-relaxed text-gray-500">
            Where will the items be presented for collection?
          </p>
        </div>

        <div className="rounded-xl bg-white p-6 shadow-sm">
          {/* Address */}
          <div className="mb-1 text-body-sm font-semibold text-[var(--brand)]">
            Address
          </div>
          <div className="mb-4 text-body-sm text-gray-700">{address}</div>

          <div className="mb-4 h-px bg-gray-100" />

          {/* Location on property */}
          <div className="mb-3 text-body-sm font-semibold text-[var(--brand)]">
            Location on property
          </div>
          <div className="mb-3 flex flex-wrap gap-2">
            {locationOptions.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setLocation(opt)}
                className={cn(
                  'rounded-full border-[1.5px] px-4 py-2 text-body-sm font-medium transition-colors',
                  location === opt
                    ? 'border-[var(--brand)] bg-[var(--brand)] text-white'
                    : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
                )}
              >
                {opt}
              </button>
            ))}
          </div>

          {/* Driveway-specific placement reminder */}
          {location === 'Driveway' && (
            <p className="mb-3 rounded-[10px] border border-[var(--brand-accent-dark)] bg-[var(--brand-accent-light)] px-3.5 py-2.5 text-xs text-[#006A38]">
              Items must be verge side of the letterbox.
            </p>
          )}

          {/* Out-of-bounds location help */}
          <p className="mb-4 text-xs leading-relaxed text-gray-500">
            If your items are not located on the front verge, side verge or
            driveway, please contact our team
            {contactPhone ? (
              <>
                {' '}
                on{' '}
                <span className="font-medium text-gray-700">{contactPhone}</span>
              </>
            ) : null}
            , or{' '}
            <Link
              href="/contact"
              className="font-medium text-[var(--brand-accent-dark)] underline hover:no-underline"
            >
              submit an enquiry
            </Link>{' '}
            to confirm whether a collection can be accommodated.
          </p>

          <div className="mb-4 h-px bg-gray-100" />

          {/* Notes */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="notes"
              className="text-xs font-medium text-gray-700"
            >
              Notes for driver
              {notesRequired ? (
                <span className="ml-0.5 text-red-500">*</span>
              ) : (
                ' (optional)'
              )}
            </label>
            <textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
              placeholder="e.g. will be on the other street side of the property"
              className="h-20 w-full resize-none rounded-[10px] border-[1.5px] border-gray-100 bg-gray-50 px-3.5 py-3 text-sm text-gray-900 outline-none transition-colors placeholder:text-gray-300 focus:border-[var(--brand)] focus:bg-white"
            />
            {notesMissing && (
              <p className="text-caption text-red-500">
                Notes for driver are required when the location is
                &ldquo;Other&rdquo;.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Bottom nav */}
      <div className="sticky bottom-16 tablet:bottom-0 flex gap-2.5 bg-gray-50 pb-5 pt-3">
        <VercoButton
          variant="secondary"
          className="flex-1"
          onClick={handleBack}
        >
          &larr; Back
        </VercoButton>
        <BookingCancelLink />
        <VercoButton
          className="flex-1"
          onClick={handleContinue}
          disabled={notesMissing}
        >
          Next step &rarr;
        </VercoButton>
      </div>
    </div>
  )
}
