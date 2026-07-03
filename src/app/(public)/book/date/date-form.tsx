'use client'

import { useSearchParams, useRouter } from 'next/navigation'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { BookingStepper } from '@/components/booking/booking-stepper'
import { BookingCancelLink } from '@/components/booking/booking-cancel-link'
import { VercoButton } from '@/components/ui/verco-button'
import { Spinner } from '@/components/ui/spinner'
import { decodeItems } from '@/lib/booking/search-params'
import { effectiveCapacity, indexPoolDates } from '@/lib/capacity/effective-capacity'
import { STATUS_CHIP, STATUS_LABEL, type DateStatus } from '@/lib/booking/calendar'
import { AvailabilityCalendar, type CalendarDate } from '@/components/booking/availability-calendar'
import { cn } from '@/lib/utils'

export function DateForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const propertyId = searchParams.get('property_id') ?? ''
  const collectionAreaId = searchParams.get('collection_area_id') ?? ''
  const address = searchParams.get('address') ?? ''
  const itemsParam = searchParams.get('items') ?? ''
  const totalCents = searchParams.get('total_cents') ?? '0'
  const onBehalf = searchParams.get('on_behalf') === 'true'

  const selectedItems = decodeItems(itemsParam)

  const [selectedDateId, setSelectedDateId] = useState<string | null>(
    searchParams.get('collection_date_id') ?? null
  )

  const supabase = createClient()

  // Determine which buckets are needed based on selected items
  const { data: neededBuckets, isLoading: neededBucketsLoading } = useQuery({
    queryKey: ['needed-buckets', itemsParam],
    enabled: selectedItems.size > 0,
    queryFn: async () => {
      const serviceIds = Array.from(selectedItems.keys())
      const { data: services } = await supabase
        .from('service')
        .select('id, name, category!inner(code)')
        .in('id', serviceIds)

      const buckets = new Set<string>()
      const names: Array<{ name: string; qty: number }> = []

      if (services) {
        for (const st of services) {
          const category = st.category as unknown as { code: string }
          buckets.add(category.code)
          names.push({ name: st.name, qty: selectedItems.get(st.id) ?? 0 })
        }
      }

      return { buckets, serviceChips: names }
    },
  })

  // Fetch the collection area's pool membership. For areas that belong to a
  // capacity_pool (e.g. WMRC's MCP pool — Mosman/Cottesloe/Peppermint Grove/
  // Fremantle North) the per-date counters on `collection_date` stay at 0 by
  // design — real capacity lives in `collection_date_pool` keyed by
  // (capacity_pool_id, date). See migration 20260513080000_capacity_pool.
  const { data: area, isLoading: areaLoading } = useQuery({
    queryKey: ['area-pool', collectionAreaId],
    enabled: !!collectionAreaId,
    queryFn: async () => {
      const { data } = await supabase
        .from('collection_area')
        .select('id, capacity_pool_id')
        .eq('id', collectionAreaId)
        .single()
      return data
    },
  })
  const poolId = area?.capacity_pool_id ?? null

  // Fetch available collection dates
  const { data: dates, isLoading: datesLoading } = useQuery({
    queryKey: ['collection-dates', collectionAreaId],
    enabled: !!collectionAreaId,
    queryFn: async () => {
      const { data } = await supabase
        .from('collection_date')
        .select('*')
        .eq('collection_area_id', collectionAreaId)
        .eq('is_open', true)
        // for_mud dates are bookable by residents alongside MUDs — the flag
        // enables MUD bookings on that date, it does not exclude residents.
        .gte('date', new Date().toISOString().split('T')[0])
        .order('date', { ascending: true })

      return data ?? []
    },
  })

  // For pooled areas, fetch the pool's per-date counters in one go and index
  // by date string so the render loop can resolve in O(1).
  const { data: poolDates, isLoading: poolDatesLoading } = useQuery({
    queryKey: ['pool-dates', poolId],
    enabled: !!poolId,
    queryFn: async () => {
      if (!poolId) return []
      const { data } = await supabase
        .from('collection_date_pool')
        .select(
          `date,
           bulk_capacity_limit, bulk_units_booked, bulk_is_closed,
           anc_capacity_limit, anc_units_booked, anc_is_closed,
           id_capacity_limit, id_units_booked, id_is_closed`,
        )
        .eq('capacity_pool_id', poolId)
        .gte('date', new Date().toISOString().split('T')[0])
      return data ?? []
    },
  })

  const poolByDate = indexPoolDates(poolDates ?? [])

  // Show loading state if any critical query is loading
  const isLoadingData = neededBucketsLoading || datesLoading || areaLoading || poolDatesLoading

  // Filter dates based on needed capacity buckets. For pooled areas a missing
  // pool row means the pool hasn't been scheduled for that date — the booking
  // RPC would reject it, so the shared helper returns it as fully closed.
  const availableDates = (dates ?? []).filter((d) => {
    if (!neededBuckets) return true
    const cap = effectiveCapacity(d, poolId, poolByDate)
    const { buckets } = neededBuckets
    if (buckets.has('bulk') && cap.bulk_is_closed) return false
    if (buckets.has('anc') && cap.anc_is_closed) return false
    return true
  })

  // Map the filtered dates into calendar cells with an availability status.
  // Closed is defensive — full/closed dates are filtered out upstream — so in
  // practice cells are Available (green) or Low Availability (amber).
  const calendarDates: CalendarDate[] = availableDates.map((d) => {
    const cap = effectiveCapacity(d, poolId, poolByDate)
    const spotsRemaining = Math.max(
      0,
      cap.bulk_capacity_limit - cap.bulk_units_booked
    )
    const status: DateStatus =
      spotsRemaining === 0 ? 'closed' : spotsRemaining <= 10 ? 'low' : 'available'
    return { id: d.id, date: new Date(d.date + 'T00:00:00'), status }
  })
  const selectedOption = calendarDates.find((c) => c.id === selectedDateId)

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
    if (!selectedDateId) return
    const params = new URLSearchParams({
      property_id: propertyId,
      collection_area_id: collectionAreaId,
      address,
      items: itemsParam,
      total_cents: totalCents,
      collection_date_id: selectedDateId,
      ...(onBehalf ? { on_behalf: 'true' } : {}),
      ...carryParams,
    })
    router.push(`/book/details?${params.toString()}`)
  }

  function handleBack() {
    const params = new URLSearchParams({
      property_id: propertyId,
      collection_area_id: collectionAreaId,
      address,
      items: itemsParam,
      total_cents: totalCents,
      ...(onBehalf ? { on_behalf: 'true' } : {}),
      ...carryParams,
    })
    router.push(`/book/services?${params.toString()}`)
  }

  return (
    <div className="flex flex-col">
      <BookingStepper currentStep={3} />

      {/* Content */}
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto pb-24 pt-6">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-title font-bold leading-tight text-[var(--brand)]">
            Select collection date
          </h1>
          <p className="mt-1 text-body-sm leading-relaxed text-gray-500">
            Choose a date for your collection at{' '}
            {address.split(',')[0] ?? address}.
          </p>
        </div>

        {/* Selected services chips */}
        {!isLoadingData && neededBuckets && neededBuckets.serviceChips.length > 0 && (
          <div className="rounded-xl bg-white px-4 py-3.5 shadow-sm">
            <div className="mb-2 text-xs font-medium text-gray-500">
              Selected services
            </div>
            <div className="flex flex-wrap gap-2">
              {neededBuckets.serviceChips.map((chip) => (
                <span
                  key={chip.name}
                  className="rounded-full border border-gray-100 bg-gray-50 px-3 py-1.5 text-[11px] font-medium text-gray-700"
                >
                  {chip.name} &times; {chip.qty}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Loading state */}
        {isLoadingData && (
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl bg-white px-4 py-12 shadow-sm">
            <Spinner size="md" />
            <p className="text-sm text-gray-500">Loading available dates...</p>
          </div>
        )}

        {/* Calendar */}
        {!isLoadingData && (
          <div>
            <h2 className="mb-3 font-[family-name:var(--font-heading)] text-base font-semibold text-[var(--brand)]">
              Available dates
            </h2>

            {calendarDates.length === 0 ? (
              <p className="py-8 text-center text-sm text-gray-500">
                No available dates for this collection area.
              </p>
            ) : (
              <>
                <AvailabilityCalendar
                  dates={calendarDates}
                  selectedId={selectedDateId}
                  onSelect={setSelectedDateId}
                />

                {/* Selected-date summary — the full status pill lives here */}
                {selectedOption && (
                  <div className="mx-auto mt-3 flex max-w-sm items-center justify-between rounded-xl bg-white px-4 py-3 shadow-sm">
                    <span className="text-body-sm font-medium text-[var(--brand)]">
                      {format(selectedOption.date, 'EEEE, d MMMM yyyy')}
                    </span>
                    <span
                      className={cn(
                        'rounded-full border px-3 py-1 text-[11px] font-medium',
                        STATUS_CHIP[selectedOption.status]
                      )}
                    >
                      {STATUS_LABEL[selectedOption.status]}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        )}
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
          disabled={!selectedDateId || isLoadingData}
        >
          Next step &rarr;
        </VercoButton>
      </div>
    </div>
  )
}
