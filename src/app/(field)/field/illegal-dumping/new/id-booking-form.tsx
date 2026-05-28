'use client'

import { useState, useEffect, useRef } from 'react'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { invokeEdgeFunction } from '@/lib/supabase/invoke-ef'
import { createIdBooking } from './actions'
import { Confirmation } from './confirmation'
import { cn } from '@/lib/utils'

const WASTE_TYPES = [
  'General / Mixed',
  'Green Waste',
  'Whitegoods',
  'Mattress',
  'E-Waste',
  'Hazardous',
  'Construction / Demolition',
] as const

const VOLUMES = [
  { label: 'Small', sub: '< 1 ute' },
  { label: 'Medium', sub: '1\u20133 utes' },
  { label: 'Large', sub: '> 3 utes' },
] as const

interface CollectionDate {
  id: string
  date: string
  id_capacity_limit: number
  id_units_booked: number
  id_is_closed: boolean
  collection_area: { id: string; code: string; name: string }
}

interface IdBookingFormProps {
  collectionDates: CollectionDate[]
}

type GpsState = 'acquiring' | 'locked' | 'error'

export function IdBookingForm({ collectionDates }: IdBookingFormProps) {
  const supabase = createClient()
  const fileInputRef = useRef<HTMLInputElement>(null)

  // GPS state
  const [gpsState, setGpsState] = useState<GpsState>('acquiring')
  const [latitude, setLatitude] = useState<number | null>(null)
  const [longitude, setLongitude] = useState<number | null>(null)
  const [accuracy, setAccuracy] = useState<number | null>(null)
  const [geoAddress, setGeoAddress] = useState('')
  const [gpsError, setGpsError] = useState<string | null>(null)

  // Form state
  const [wasteTypes, setWasteTypes] = useState<string[]>([])
  const [volume, setVolume] = useState('')
  const [description, setDescription] = useState('')
  const [photos, setPhotos] = useState<string[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [selectedDateId, setSelectedDateId] = useState<string | null>(null)
  const [notes, setNotes] = useState('')

  // Submit state
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submittedData, setSubmittedData] = useState<{
    ref: string
    geoAddress: string
    wasteTypes: string[]
    volume: string
    collectionDate: string
  } | null>(null)

  // Declared above the useEffect that calls it. Function declarations are
  // hoisted in JS so the reverse order works at runtime, but react-hooks/
  // immutability flags the forward reference — declaration-before-use is
  // both clearer and lint-clean.
  async function reverseGeocode(lat: number, lng: number) {
    try {
      const data = await invokeEdgeFunction<{ address?: string | null }>(
        'google-places-proxy',
        { latlng: `${lat},${lng}`, type: 'reverse' }
      )
      if (data?.address) {
        setGeoAddress(data.address)
      }
    } catch {
      // Fallback: use raw coordinates as address
      setGeoAddress(`${lat.toFixed(4)}, ${lng.toFixed(4)}`)
    }
  }

  // Request geolocation on mount
  useEffect(() => {
    if (!navigator.geolocation) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional initialization-failed signal; the async geolocation API path also calls setState in callbacks, so this matches the established pattern
      setGpsState('error')
      setGpsError('Geolocation is not supported by this browser.')
      return
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLatitude(position.coords.latitude)
        setLongitude(position.coords.longitude)
        setAccuracy(Math.round(position.coords.accuracy))
        setGpsState('locked')

        // Attempt reverse geocode via browser
        void reverseGeocode(position.coords.latitude, position.coords.longitude)
      },
      (err) => {
        setGpsState('error')
        setGpsError(
          err.code === 1
            ? 'Location permission denied. Please enable location services.'
            : 'Unable to determine location. Please try again.'
        )
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    )
  }, [])

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
    const newUrls: string[] = []
    const failed: string[] = []

    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop() ?? 'jpg'
      const path = `id-bookings/${crypto.randomUUID()}.${ext}`

      const { data, error: uploadError } = await supabase.storage
        .from('ncn-photos')
        .upload(path, file)

      if (uploadError || !data) {
        failed.push(file.name)
        continue
      }

      const { data: urlData } = supabase.storage
        .from('ncn-photos')
        .getPublicUrl(data.path)
      newUrls.push(urlData.publicUrl)
    }

    if (newUrls.length > 0) {
      setPhotos((prev) => [...prev, ...newUrls])
    }

    if (failed.length > 0) {
      setError(
        `Couldn't upload ${failed.length} photo${failed.length > 1 ? 's' : ''}. Check your connection and try again.`
      )
    }

    // Reset the input so the same file can be re-selected after a failure.
    if (fileInputRef.current) fileInputRef.current.value = ''
    setIsUploading(false)
  }

  async function handleSubmit() {
    if (gpsState !== 'locked' || latitude === null || longitude === null) {
      setError('GPS location required.')
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
    if (photos.length === 0) {
      setError('At least one photo is required.')
      return
    }
    if (!selectedDateId) {
      setError('Select a collection date.')
      return
    }

    const selectedDate = collectionDates.find((d) => d.id === selectedDateId)
    if (!selectedDate) {
      setError('Invalid collection date.')
      return
    }

    setIsSubmitting(true)
    setError(null)

    const area = selectedDate.collection_area as { id: string }

    const result = await createIdBooking({
      latitude,
      longitude,
      geo_address: geoAddress,
      collection_date_id: selectedDateId,
      collection_area_id: area.id,
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

    setSubmittedData({
      ref: result.data.ref,
      geoAddress,
      wasteTypes,
      volume,
      collectionDate: selectedDate.date,
    })
  }

  // Show confirmation screen
  if (submittedData) {
    return (
      <Confirmation
        bookingRef={submittedData.ref}
        geoAddress={submittedData.geoAddress}
        wasteTypes={submittedData.wasteTypes}
        volume={submittedData.volume}
        collectionDate={submittedData.collectionDate}
      />
    )
  }

  const isLocked = gpsState === 'locked'

  return (
    <div className="flex flex-col gap-3 px-5 pt-4">
      <div>
        <h1 className="font-[family-name:var(--font-heading)] text-lg font-bold text-[var(--brand)]">
          New ID Collection
        </h1>
        <p className="mt-0.5 text-body-sm text-gray-500">
          Illegal dumping &mdash; log location and schedule collection
        </p>
      </div>

      {/* Location card */}
      <div className="flex flex-col gap-3 rounded-xl bg-white p-3.5 shadow-sm">
        <div className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
          Location
        </div>

        {/* Map tile */}
        {isLocked ? (
          <div className="relative h-[180px] overflow-hidden rounded-[10px] border-[1.5px] border-gray-100 bg-gradient-to-br from-[#dde8d4] to-[#cddfc5]">
            {/* Accuracy circle */}
            <div className="absolute left-1/2 top-1/2 size-20 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--brand)]/20 bg-[var(--brand)]/[0.08]" />
            {/* Red pin */}
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-[70%]">
              <div className="size-9 rotate-[-45deg] rounded-[50%_50%_50%_0] border-[3px] border-white bg-[#E53E3E] shadow-[0_3px_10px_rgba(0,0,0,0.3)]" />
              <div className="absolute left-1/2 top-1/2 size-2.5 -translate-x-1/2 -translate-y-[55%] rotate-45 rounded-full bg-white" />
            </div>
            {/* Coords badge */}
            <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-white/[0.92] px-2 py-1 text-[11px] font-medium text-[var(--brand)]">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              {latitude?.toFixed(4)}, {longitude?.toFixed(4)}
            </div>
          </div>
        ) : (
          <div className="flex h-[180px] flex-col items-center justify-center gap-2.5 rounded-[10px] border-2 border-dashed border-gray-100 bg-gray-100">
            {gpsState === 'acquiring' && (
              <>
                <div className="size-12 animate-spin rounded-full border-[3px] border-gray-100 border-t-[var(--brand)]" />
                <span className="text-body-sm font-medium text-gray-700">
                  Acquiring GPS location...
                </span>
                <span className="text-[11px] text-gray-500">
                  Make sure location services are enabled
                </span>
              </>
            )}
            {gpsState === 'error' && (
              <>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#E53E3E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span className="text-body-sm font-medium text-gray-700">
                  {gpsError}
                </span>
              </>
            )}
          </div>
        )}

        {/* GPS status */}
        <div
          className={cn(
            'flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium',
            isLocked
              ? 'bg-[var(--brand-accent-light)] text-[#006A38]'
              : 'bg-[#FFF3EA] text-[#8B4000]'
          )}
        >
          <div
            className={cn(
              'size-2 shrink-0 rounded-full',
              isLocked ? 'bg-[var(--brand-accent-dark)]' : 'bg-[#FF8C42]'
            )}
          />
          {isLocked
            ? `GPS locked · \u00b1${accuracy}m accuracy`
            : 'Searching for GPS signal...'}
        </div>

        {/* Address field */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-gray-700">
            Address or nearest landmark
          </label>
          <input
            type="text"
            value={geoAddress}
            onChange={(e) => setGeoAddress(e.target.value)}
            placeholder="Will be filled automatically from GPS..."
            className={cn(
              'w-full rounded-[10px] border-[1.5px] bg-gray-50 px-3.5 py-2.5 text-sm text-gray-900 outline-none placeholder:text-gray-300',
              isLocked
                ? 'border-[var(--brand)] border-2 bg-white'
                : 'border-gray-100'
            )}
          />
        </div>
      </div>

      {/* Waste Description — locked until GPS */}
      <div
        className={cn(
          'flex flex-col gap-3 rounded-xl bg-white p-3.5 shadow-sm',
          !isLocked && 'pointer-events-none opacity-40'
        )}
      >
        <div className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
          Waste Description
        </div>

        {isLocked ? (
          <>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-gray-700">
                Type of waste <span className="text-[#E53E3E]">*</span>
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {WASTE_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => toggleWasteType(type)}
                    className={cn(
                      'rounded-lg border-[1.5px] px-3 py-2.5 text-center text-xs font-medium transition-colors',
                      type === 'Construction / Demolition' && 'col-span-2',
                      wasteTypes.includes(type)
                        ? 'border-[var(--brand)] bg-[#E8EEF2] text-[var(--brand)]'
                        : 'border-gray-100 bg-white text-gray-700'
                    )}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-gray-700">
                Estimated volume <span className="text-[#E53E3E]">*</span>
              </label>
              <div className="flex gap-1.5">
                {VOLUMES.map((v) => (
                  <button
                    key={v.label}
                    type="button"
                    onClick={() => setVolume(`${v.label} (${v.sub})`)}
                    className={cn(
                      'flex flex-1 flex-col items-center rounded-lg border-[1.5px] px-2 py-2.5 text-center text-xs font-medium transition-colors',
                      volume.startsWith(v.label)
                        ? 'border-[var(--brand)] bg-[#E8EEF2] text-[var(--brand)]'
                        : 'border-gray-100 bg-white text-gray-700'
                    )}
                  >
                    {v.label}
                    <span className="text-2xs font-normal text-gray-500">
                      {v.sub}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-gray-700">
                Description
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the waste found..."
                className="h-[72px] w-full resize-none rounded-[10px] border-[1.5px] border-gray-100 bg-gray-50 px-3.5 py-2.5 text-body-sm text-gray-900 outline-none placeholder:text-gray-300 focus:border-[var(--brand)] focus:bg-white"
              />
            </div>
          </>
        ) : (
          <div className="text-xs text-gray-500">
            Available after location is confirmed
          </div>
        )}
      </div>

      {/* Photos — locked until GPS */}
      <div
        className={cn(
          'flex flex-col gap-3 rounded-xl bg-white p-3.5 shadow-sm',
          !isLocked && 'pointer-events-none opacity-40'
        )}
      >
        <div className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
          Photos{' '}
          <span className="text-2xs font-normal normal-case tracking-normal text-gray-400">
            (min. 1 required)
          </span>
        </div>

        {isLocked ? (
          <div className="flex flex-wrap gap-2">
            {photos.map((url, i) => (
              <div
                key={i}
                className="size-[76px] overflow-hidden rounded-lg bg-gray-100"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt={`Photo ${i + 1}`}
                  className="size-full object-cover"
                />
              </div>
            ))}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="flex size-[76px] flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-gray-300"
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
              capture="environment"
              onChange={handlePhotoUpload}
              className="hidden"
            />
          </div>
        ) : (
          <div className="text-xs text-gray-500">
            Available after location is confirmed
          </div>
        )}
      </div>

      {/* Collection Date — only show when GPS locked */}
      {isLocked && collectionDates.length > 0 && (
        <div className="flex flex-col gap-3 rounded-xl bg-white p-3.5 shadow-sm">
          <div className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
            Collection Date
          </div>
          <div className="grid grid-cols-3 gap-2">
            {collectionDates.map((d) => {
              const isSelected = d.id === selectedDateId
              const spotsRemaining = Math.max(
                0,
                d.id_capacity_limit - d.id_units_booked
              )
              const area = d.collection_area as { code: string }
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setSelectedDateId(d.id)}
                  className={cn(
                    'flex flex-col gap-0.5 rounded-xl border-[1.5px] px-2 py-2.5 shadow-sm transition-colors',
                    isSelected
                      ? 'border-[var(--brand-accent)] border-2 bg-[var(--brand)]'
                      : 'border-gray-100 bg-white'
                  )}
                >
                  <span
                    className={cn(
                      'text-xs font-semibold',
                      isSelected ? 'text-white' : 'text-[var(--brand)]'
                    )}
                  >
                    {format(new Date(d.date + 'T00:00:00'), 'EEE d MMM')}
                  </span>
                  <span
                    className={cn(
                      'text-2xs',
                      isSelected ? 'text-green-200/80' : 'text-gray-500'
                    )}
                  >
                    {spotsRemaining} ID spots
                  </span>
                  {isSelected && (
                    <span className="text-2xs font-medium text-[var(--brand-accent)]">
                      Selected &#10003;
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          <div className="text-[11px] text-gray-500">
            Draws from ID capacity bucket
          </div>
        </div>
      )}

      {/* Additional Notes */}
      {isLocked && (
        <div className="flex flex-col gap-3 rounded-xl bg-white p-3.5 shadow-sm">
          <div className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
            Additional Notes
          </div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Access notes, hazards, special instructions for field crew..."
            className="h-[72px] w-full resize-none rounded-[10px] border-[1.5px] border-gray-100 bg-gray-50 px-3.5 py-2.5 text-body-sm text-gray-900 outline-none placeholder:text-gray-300 focus:border-[var(--brand)] focus:bg-white"
          />
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700">
          {error}
        </div>
      )}

      {/* Submit */}
      {isLocked && (
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitting}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--brand)] px-3.5 py-3.5 font-[family-name:var(--font-heading)] text-body font-semibold text-white disabled:opacity-50"
        >
          {isSubmitting ? (
            'Submitting...'
          ) : (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Submit ID Collection
            </>
          )}
        </button>
      )}
    </div>
  )
}
