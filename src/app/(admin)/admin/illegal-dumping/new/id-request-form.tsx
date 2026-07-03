'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { invokeEdgeFunction } from '@/lib/supabase/invoke-ef'
import { AddressAutocomplete } from '@/components/booking/address-autocomplete'
import { cn } from '@/lib/utils'
import {
  ID_WASTE_TYPES,
  ID_VOLUMES,
  ID_PHOTOS_BUCKET,
  ID_PHOTOS_PREFIX,
} from '@/lib/booking/id-options'
import { matchAddressToArea, resolveAreaSuggestion } from '@/lib/booking/id-area-suggestion'
import { AvailabilityCalendar, type CalendarDate } from '@/components/booking/availability-calendar'
import { STATUS_CHIP, type DateStatus } from '@/lib/booking/calendar'
import { createAdminIdBooking } from './actions'

export interface AreaOption {
  id: string
  code: string
  name: string
}

export interface IdDateOption {
  id: string
  date: string
  id_capacity_limit: number
  id_units_booked: number
  collection_area_id: string
}

interface IdRequestFormProps {
  areas: AreaOption[]
  dates: IdDateOption[]
  // Contractor-admins may schedule any future date that still has ID capacity,
  // including admin- or system-closed dates: page.tsx widens the date fetch and
  // create_id_booking_with_capacity_check relaxes the closure gate for this
  // role. The capacity ceiling is never overridden. Drives the helper note.
  isContractorAdmin?: boolean
}

export function IdRequestForm({
  areas,
  dates,
  isContractorAdmin = false,
}: IdRequestFormProps) {
  const supabase = createClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Discards stale geocode responses when the user re-selects an address
  // while a lookup is still in flight — an out-of-order resolution would
  // otherwise pin the previous address's coordinates under the new text.
  const geocodeSeqRef = useRef(0)
  const successHeadingRef = useRef<HTMLHeadingElement>(null)

  // Location — pinned by resolving the autocomplete selection to coordinates.
  const [geoAddress, setGeoAddress] = useState('')
  const [latitude, setLatitude] = useState<number | null>(null)
  const [longitude, setLongitude] = useState<number | null>(null)
  const [isGeocoding, setIsGeocoding] = useState(false)
  const [locationError, setLocationError] = useState<string | null>(null)

  // Form state
  const [wasteTypes, setWasteTypes] = useState<string[]>([])
  const [volume, setVolume] = useState('')
  const [description, setDescription] = useState('')
  const [photos, setPhotos] = useState<string[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [areaId, setAreaId] = useState('')
  const [selectedDateId, setSelectedDateId] = useState('')
  const [notes, setNotes] = useState('')
  // Area the pinned address resolved to via eligible_properties — null when
  // the address didn't match a property (parks/verges are legitimate).
  const [matchedAreaId, setMatchedAreaId] = useState<string | null>(null)

  // Submit state
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<{
    ref: string
    bookingId: string
    geoAddress: string
    collectionDate: string
  } | null>(null)

  // Move screen-reader focus to the confirmation once the booking lands.
  useEffect(() => {
    if (submitted) successHeadingRef.current?.focus()
  }, [submitted])

  // Every in-horizon date for the chosen area — the server already capped the
  // 90-day window and applied role-appropriate closure filtering, and the
  // calendar spans months, so there's no client-side slice.
  const areaDates = dates.filter((d) => d.collection_area_id === areaId)

  // Only dates with capacity left are selectable; full dates drop out and
  // render as inert day-numbers. ID buckets are small, so 1–2 free spots read
  // as "low".
  const calendarDates: CalendarDate[] = areaDates.flatMap((d) => {
    const spots = Math.max(0, d.id_capacity_limit - d.id_units_booked)
    if (spots === 0) return []
    const status: DateStatus = spots <= 2 ? 'low' : 'available'
    return [{ id: d.id, date: new Date(d.date + 'T00:00:00'), status }]
  })
  const selectedAreaDate = areaDates.find((d) => d.id === selectedDateId) ?? null
  const selectedSpots = selectedAreaDate
    ? Math.max(0, selectedAreaDate.id_capacity_limit - selectedAreaDate.id_units_booked)
    : 0
  const selectedStatus: DateStatus | null = selectedAreaDate
    ? selectedSpots <= 2
      ? 'low'
      : 'available'
    : null

  const isPinned = latitude !== null && longitude !== null

  const areaSuggestion = resolveAreaSuggestion(
    matchedAreaId,
    areaId,
    areas.map((a) => a.id)
  )
  const areaCode = (id: string) => areas.find((a) => a.id === id)?.code ?? 'another area'

  async function handleAddressSelect(placeId: string, suggestion: string) {
    const seq = ++geocodeSeqRef.current
    setGeoAddress(suggestion)
    setLatitude(null)
    setLongitude(null)
    setMatchedAreaId(null)
    setIsGeocoding(true)
    setLocationError(null)
    try {
      const data = await invokeEdgeFunction<{
        address: string | null
        latitude: number | null
        longitude: number | null
        error?: string
      }>('google-places-proxy', { place_id: placeId, type: 'geocode' })
      if (seq !== geocodeSeqRef.current) return
      if (data.error) {
        setLocationError('Address lookup failed. Try again in a moment.')
      } else if (typeof data.latitude !== 'number' || typeof data.longitude !== 'number') {
        setLocationError(
          'Could not pin coordinates for that address. Try a nearby street address.'
        )
      } else {
        setLatitude(data.latitude)
        setLongitude(data.longitude)
        // Soft address↔area consistency (best-effort, never blocks): resolve
        // the address to a collection area via eligible_properties.
        // Auto-selects the area if none is picked yet; a disagreement renders
        // a warning next to the area select.
        try {
          const matched = await matchAddressToArea(supabase, {
            placeId,
            address: suggestion,
            areaIds: areas.map((a) => a.id),
          })
          if (seq !== geocodeSeqRef.current) return
          setMatchedAreaId(matched)
          if (matched) {
            setAreaId((prev) => prev || matched)
          }
        } catch {
          // Match is advisory only — swallow lookup failures.
        }
      }
    } catch {
      if (seq !== geocodeSeqRef.current) return
      setLocationError('Address lookup failed. Check your connection and try again.')
    } finally {
      if (seq === geocodeSeqRef.current) setIsGeocoding(false)
    }
  }

  function toggleWasteType(type: string) {
    setWasteTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    )
  }

  async function handlePhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return

    setIsUploading(true)
    setError(null)

    const results = await Promise.all(
      Array.from(files).map(async (file) => {
        const ext = file.name.split('.').pop() ?? 'jpg'
        const path = `${ID_PHOTOS_PREFIX}/${crypto.randomUUID()}.${ext}`
        try {
          const { data, error: uploadError } = await supabase.storage
            .from(ID_PHOTOS_BUCKET)
            .upload(path, file)
          if (uploadError || !data) return { ok: false as const }
          const { data: urlData } = supabase.storage
            .from(ID_PHOTOS_BUCKET)
            .getPublicUrl(data.path)
          return { ok: true as const, url: urlData.publicUrl }
        } catch {
          return { ok: false as const }
        }
      })
    )

    const newUrls = results.filter((r) => r.ok).map((r) => r.url)
    const failedCount = results.length - newUrls.length

    if (newUrls.length > 0) {
      setPhotos((prev) => [...prev, ...newUrls])
    }
    if (failedCount > 0) {
      setError(
        `Couldn't upload ${failedCount} photo${failedCount > 1 ? 's' : ''}. Check your connection and try again.`
      )
    }

    // Reset the input so the same file can be re-selected after a failure.
    if (fileInputRef.current) fileInputRef.current.value = ''
    setIsUploading(false)
  }

  function removePhoto(url: string) {
    setPhotos((prev) => prev.filter((u) => u !== url))
  }

  async function handleSubmit() {
    if (!isPinned || latitude === null || longitude === null) {
      setError('Select an address from the suggestions to pin the location.')
      return
    }
    if (!geoAddress.trim()) {
      setError('Address is required.')
      return
    }
    if (wasteTypes.length === 0) {
      setError('Select at least one waste type.')
      return
    }
    if (!volume) {
      setError('Select an estimated volume.')
      return
    }
    if (!areaId) {
      setError('Select a collection area.')
      return
    }
    const selectedDate = areaDates.find((d) => d.id === selectedDateId)
    if (!selectedDate) {
      setError('Select a collection date.')
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      const result = await createAdminIdBooking({
        latitude,
        longitude,
        geo_address: geoAddress.trim(),
        collection_date_id: selectedDate.id,
        collection_area_id: areaId,
        waste_types: wasteTypes,
        volume,
        description,
        photo_urls: photos,
        notes,
      })

      if (!result.ok) {
        setError(result.error)
        setIsSubmitting(false)
        return
      }

      setSubmitted({
        ref: result.data.ref,
        bookingId: result.data.bookingId,
        geoAddress: geoAddress.trim(),
        collectionDate: selectedDate.date,
      })
    } catch {
      setError('Something went wrong submitting the ID collection. Please try again.')
      setIsSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <div className="mx-auto mt-10 flex w-full max-w-xl flex-col items-center rounded-xl bg-white px-8 py-10 shadow-sm">
        <div className="flex size-14 items-center justify-center rounded-full bg-emerald-50">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h2
          ref={successHeadingRef}
          tabIndex={-1}
          className="mt-4 font-[family-name:var(--font-heading)] text-lg font-bold text-[#293F52] outline-none"
        >
          ID Collection Logged
        </h2>
        <p className="mt-1 text-center text-body-sm text-gray-500">
          Booking <span className="font-semibold text-[#293F52]">{submitted.ref}</span> at{' '}
          {submitted.geoAddress} is confirmed for{' '}
          {format(new Date(submitted.collectionDate + 'T00:00:00'), 'EEE d MMMM yyyy')}.
        </p>
        <div className="mt-6 flex gap-2">
          <Link
            href={`/admin/bookings/${submitted.bookingId}`}
            className="rounded-lg bg-[#293F52] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#1e3040]"
          >
            View Booking
          </Link>
          <Link
            href="/admin/illegal-dumping"
            className="rounded-lg border-[1.5px] border-gray-100 bg-white px-4 py-2 text-sm font-semibold text-[#293F52] transition-colors hover:bg-gray-50"
          >
            Back to Illegal Dumping
          </Link>
          <button
            type="button"
            onClick={() => {
              setSubmitted(null)
              setGeoAddress('')
              setLatitude(null)
              setLongitude(null)
              setLocationError(null)
              setMatchedAreaId(null)
              setWasteTypes([])
              setVolume('')
              setDescription('')
              setPhotos([])
              setAreaId('')
              setSelectedDateId('')
              setNotes('')
              setIsSubmitting(false)
            }}
            className="rounded-lg border-[1.5px] border-gray-100 bg-white px-4 py-2 text-sm font-semibold text-[#293F52] transition-colors hover:bg-gray-50"
          >
            Log Another
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      {/* Location */}
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <div className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
          Location
        </div>
        <div className="mt-3 flex flex-col gap-1.5">
          <label htmlFor="id-address-search" className="text-xs font-medium text-gray-700">
            Address of the dumped waste <span aria-hidden="true" className="text-[#E53E3E]">*</span>
          </label>
          <AddressAutocomplete
            inputId="id-address-search"
            onSelect={handleAddressSelect}
            placeholder="Start typing the street address..."
          />
        </div>
        <div
          role="status"
          className={cn(
            'mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium',
            locationError
              ? 'bg-red-50 text-red-700'
              : isPinned
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-amber-50 text-amber-700'
          )}
        >
          <div
            className={cn(
              'size-2 shrink-0 rounded-full',
              locationError ? 'bg-red-500' : isPinned ? 'bg-emerald-500' : 'bg-amber-400'
            )}
          />
          {isGeocoding
            ? 'Pinning location...'
            : locationError
              ? locationError
              : isPinned
                ? `Location pinned · ${latitude?.toFixed(5)}, ${longitude?.toFixed(5)}`
                : 'Select an address from the suggestions to pin the location'}
        </div>
        {isPinned && (
          <div className="mt-3 flex flex-col gap-1.5">
            <label htmlFor="id-geo-address" className="text-xs font-medium text-gray-700">
              Location description shown to the crew
            </label>
            <input
              id="id-geo-address"
              type="text"
              value={geoAddress}
              onChange={(e) => setGeoAddress(e.target.value)}
              className="w-full rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-[#293F52]"
            />
            <p className="text-[11px] text-gray-500">
              Edit freely — e.g. &ldquo;verge opposite 12 Smith St, next to the park entrance&rdquo;.
              The pinned coordinates stay unchanged.
            </p>
          </div>
        )}
      </div>

      {/* Waste description */}
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <div className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
          Waste Description
        </div>
        <fieldset className="mt-3">
          <legend className="text-xs font-medium text-gray-700">
            Type of waste <span aria-hidden="true" className="text-[#E53E3E]">*</span>
          </legend>
          <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {ID_WASTE_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                aria-pressed={wasteTypes.includes(type)}
                onClick={() => toggleWasteType(type)}
                className={cn(
                  'rounded-lg border-[1.5px] px-3 py-2 text-center text-xs font-medium transition-colors',
                  wasteTypes.includes(type)
                    ? 'border-[#293F52] bg-[#E8EEF2] text-[#293F52]'
                    : 'border-gray-100 bg-white text-gray-700 hover:bg-gray-50'
                )}
              >
                {type}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="mt-4">
          <legend className="text-xs font-medium text-gray-700">
            Estimated volume <span aria-hidden="true" className="text-[#E53E3E]">*</span>
          </legend>
          <div className="mt-1.5 flex max-w-sm gap-1.5">
            {ID_VOLUMES.map((v) => (
              <button
                key={v.label}
                type="button"
                aria-pressed={volume.startsWith(v.label)}
                onClick={() => setVolume(`${v.label} (${v.sub})`)}
                className={cn(
                  'flex flex-1 flex-col items-center rounded-lg border-[1.5px] px-2 py-2 text-center text-xs font-medium transition-colors',
                  volume.startsWith(v.label)
                    ? 'border-[#293F52] bg-[#E8EEF2] text-[#293F52]'
                    : 'border-gray-100 bg-white text-gray-700 hover:bg-gray-50'
                )}
              >
                {v.label}
                <span className="text-2xs font-normal text-gray-500">{v.sub}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <div className="mt-4 flex flex-col gap-1.5">
          <label htmlFor="id-description" className="text-xs font-medium text-gray-700">
            Description
          </label>
          <textarea
            id="id-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the reported waste..."
            className="h-[72px] w-full resize-none rounded-lg border-[1.5px] border-gray-100 bg-gray-50 px-3 py-2 text-body-sm text-gray-900 outline-none placeholder:text-gray-300 focus:border-[#293F52] focus:bg-white"
          />
        </div>
      </div>

      {/* Photos — optional for phoned-in reports */}
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <div className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
          Photos{' '}
          <span className="text-2xs font-normal normal-case tracking-normal text-gray-400">
            (optional)
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {photos.map((url, i) => (
            <div key={url} className="relative size-[76px] overflow-hidden rounded-lg bg-gray-100">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt={`Photo ${i + 1}`} className="size-full object-cover" />
              <button
                type="button"
                onClick={() => removePhoto(url)}
                aria-label={`Remove photo ${i + 1}`}
                className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="flex size-[76px] flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-gray-300 transition-colors hover:bg-gray-50"
          >
            {isUploading ? (
              <span className="text-2xs text-gray-400">...</span>
            ) : (
              <>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#B0B0B0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="5" width="20" height="15" rx="2" />
                  <circle cx="12" cy="12" r="4" />
                  <path d="M9 5l1.5-2h3L15 5" />
                  <line x1="18" y1="2" x2="18" y2="6" />
                  <line x1="16" y1="4" x2="20" y2="4" />
                </svg>
                <span className="text-2xs text-gray-500">Add photo</span>
              </>
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handlePhotoUpload}
            className="hidden"
            aria-label="Upload photos"
          />
        </div>
      </div>

      {/* Collection date */}
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <div className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
          Collection Date
        </div>
        <div className="mt-3 flex flex-col gap-1.5">
          <label htmlFor="id-area-select" className="text-xs font-medium text-gray-700">
            Collection area <span aria-hidden="true" className="text-[#E53E3E]">*</span>
          </label>
          <select
            id="id-area-select"
            value={areaId}
            onChange={(e) => {
              setAreaId(e.target.value)
              setSelectedDateId('')
            }}
            className="w-full max-w-sm rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-2 text-sm text-gray-700 outline-none focus:border-[#293F52]"
          >
            <option value="">Select an area...</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </div>
        {areaSuggestion.kind === 'agree' && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-emerald-600" role="status">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Matches the pinned address ({areaCode(areaSuggestion.areaId)})
          </p>
        )}
        {areaSuggestion.kind === 'suggest' && (
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600" role="status">
            This address looks like it&rsquo;s in {areaCode(areaSuggestion.areaId)}.
            <button
              type="button"
              onClick={() => {
                setAreaId(areaSuggestion.areaId)
                setSelectedDateId('')
              }}
              className="font-semibold text-[#293F52] underline"
            >
              Use {areaCode(areaSuggestion.areaId)}
            </button>
          </div>
        )}
        {areaSuggestion.kind === 'mismatch' && (
          <div
            className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
            role="status"
          >
            <span>
              The pinned address matches {areaCode(areaSuggestion.matchedAreaId)}, but{' '}
              {areaCode(areaSuggestion.selectedAreaId)} is selected. The crew is routed to the
              pinned location — double-check before submitting.
            </span>
            <button
              type="button"
              onClick={() => {
                setAreaId(areaSuggestion.matchedAreaId)
                setSelectedDateId('')
              }}
              className="font-semibold text-amber-900 underline"
            >
              Switch to {areaCode(areaSuggestion.matchedAreaId)}
            </button>
          </div>
        )}
        {areaId && calendarDates.length === 0 && (
          <p className="mt-3 text-body-sm text-gray-500">
            No upcoming ID-eligible collection dates with capacity for this area.
            Check the area&rsquo;s collection dates and ID capacity settings.
          </p>
        )}
        {calendarDates.length > 0 && (
          <div className="mt-3">
            <AvailabilityCalendar
              dates={calendarDates}
              selectedId={selectedDateId || null}
              onSelect={setSelectedDateId}
            />
            {selectedAreaDate && selectedStatus && (
              <div className="mx-auto mt-3 flex max-w-sm items-center justify-between rounded-xl bg-white px-4 py-3 shadow-sm ring-1 ring-gray-100">
                <span className="text-body-sm font-medium text-[#293F52]">
                  {format(new Date(selectedAreaDate.date + 'T00:00:00'), 'EEEE, d MMMM yyyy')}
                </span>
                <span
                  className={cn(
                    'rounded-full border px-3 py-1 text-[11px] font-medium',
                    STATUS_CHIP[selectedStatus]
                  )}
                >
                  {selectedSpots} ID spot{selectedSpots !== 1 ? 's' : ''}
                </span>
              </div>
            )}
          </div>
        )}
        <p className="mt-3 text-[11px] text-gray-500">Draws from the ID capacity bucket.</p>
        {isContractorAdmin && (
          <p className="mt-1 text-[11px] text-gray-500">
            As a contractor admin you can schedule any future date that still has
            ID capacity — including dates closed to standard booking.
          </p>
        )}
      </div>

      {/* Notes */}
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <label
          htmlFor="id-notes"
          className="text-2xs font-semibold uppercase tracking-wide text-gray-500"
        >
          Additional Notes
        </label>
        <textarea
          id="id-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Access notes, hazards, special instructions for field crew..."
          className="mt-3 h-[72px] w-full resize-none rounded-lg border-[1.5px] border-gray-100 bg-gray-50 px-3 py-2 text-body-sm text-gray-900 outline-none placeholder:text-gray-300 focus:border-[#293F52] focus:bg-white"
        />
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700"
        >
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2 pb-2">
        <Link
          href="/admin/illegal-dumping"
          className="rounded-lg border-[1.5px] border-gray-100 bg-white px-4 py-2 text-sm font-semibold text-[#293F52] transition-colors hover:bg-gray-50"
        >
          Cancel
        </Link>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitting}
          className="rounded-lg bg-[#293F52] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#1e3040] disabled:opacity-50"
        >
          {isSubmitting ? 'Submitting...' : 'Log ID Collection'}
        </button>
      </div>
    </div>
  )
}
