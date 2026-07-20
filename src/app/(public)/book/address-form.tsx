'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { BookingStepper } from '@/components/booking/booking-stepper'
import { AddressAutocomplete } from '@/components/booking/address-autocomplete'
import { Spinner } from '@/components/ui/spinner'
import { VercoButton } from '@/components/ui/verco-button'
import { stripAddressPrefix } from '@/lib/mud/address-strip'
import { formatFinancialYearLabel } from '@/lib/booking/financial-year'
import { finiteCoord } from '@/lib/booking/finite-coord'
import { isAreaBookable } from '@/lib/booking/area-gate'
import {
  addressMatchKey as buildAddressMatchKey,
  buildAddressIlikePattern,
  buildEligibleOrFilter,
  buildLookupCandidates,
  rowsAreSameProperty,
  extractSuburb,
  filterBySuburbAgreement,
} from '@/lib/booking/address-match-key'
import { decideMudRedirect, type MudLookupCandidate } from '@/lib/mud/mud-lookup'
import type { Database } from '@/lib/supabase/types'

type EligibleProperty = Database['public']['Tables']['eligible_properties']['Row']

// Lookup rows embed the area's go-live flag so the gate can read it (WS-A / VER-269).
type EligiblePropertyRow = EligibleProperty & {
  collection_area: { client_id: string; is_active: boolean } | null
}

interface MudRedirectState {
  building_address: string
}

const PropertyMap = dynamic(
  () =>
    import('@/components/booking/property-map').then((mod) => mod.PropertyMap),
  { ssr: false }
)

// Re-export under the local name so the rest of this file reads the same.
const addressMatchKey = buildAddressMatchKey

export function AddressForm({
  clientId,
  serviceName,
}: {
  clientId: string
  serviceName: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const supabase = createClient()

  const initialAddress = searchParams.get('address') ?? ''
  const onBehalf = searchParams.get('on_behalf') === 'true'

  const [selectedProperty, setSelectedProperty] = useState<EligibleProperty | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [hasAutoResolved, setHasAutoResolved] = useState(false)
  const [mudRedirect, setMudRedirect] = useState<MudRedirectState | null>(null)
  const [notYetAvailable, setNotYetAvailable] = useState(false)

  // Shared lookup function used by both manual selection and auto-resolve.
  //
  // Primary path: authoritative Google place_id match, tenant-scoped.
  // Fallback: suburb-aware ILIKE on formatted_address, tenant-scoped — used for
  // rows with null google_place_id and the ?address= auto-resolve path. If the
  // first pass misses, retry with the MUD unit-prefix stripped
  // (e.g. "Unit 5 / 18 Sulphur Rd, Kwinana" → "18 Sulphur Rd, Kwinana") so
  // residents who typed a unit prefix still resolve to the MUD building.
  const lookupProperty = useCallback(
    async (searchStr: string, placeId?: string) => {
      setNotFound(false)
      setSelectedProperty(null)
      setMudRedirect(null)
      setNotYetAvailable(false)

      const tryLookup = async (
        s: string,
        pid?: string
      ): Promise<EligiblePropertyRow | null> => {
        if (pid) {
          // Duplicate imports mean a place_id can resolve to 2+ rows under one
          // client (same physical property). `.maybeSingle()` would error on >1
          // row and report an eligible address as "not eligible", so take the
          // earliest deterministically instead — they are the same property.
          const { data } = await supabase
            .from('eligible_properties')
            .select('*, collection_area!inner(client_id, is_active)')
            .eq('google_place_id', pid)
            .eq('collection_area.client_id', clientId)
            .order('created_at', { ascending: true })
            .limit(1)
          const row = data?.[0]
          if (row) return row as unknown as EligiblePropertyRow
        }

        const key = addressMatchKey(s)
        if (!key) return null

        // Search both formatted_address (geocoded rows) and address (un-geocoded rows
        // such as newly imported MUDs). Use the street-segment only for the address
        // column because Airtable values often lack the suburb/state suffix. Both
        // patterns can carry a comma, so buildEligibleOrFilter double-quotes each
        // value — a bare comma would otherwise split the PostgREST .or() condition.
        const fmtPattern = buildAddressIlikePattern(key)
        const streetSegment = s.split(',')[0]?.trim() ?? s
        const addrPattern = buildAddressIlikePattern(addressMatchKey(streetSegment))
        // Fetch a small window and auto-resolve only when every match is the
        // SAME physical property (duplicate import). rowsAreSameProperty keeps
        // the VER-214 protection: genuinely different houses still bail to "not
        // found" rather than silently resolving to the wrong one.
        const { data } = await supabase
          .from('eligible_properties')
          .select('*, collection_area!inner(client_id, is_active)')
          .or(buildEligibleOrFilter(fmtPattern, addrPattern))
          .eq('collection_area.client_id', clientId)
          .order('created_at', { ascending: true })
          .limit(5)
        // Reject same-street namesakes in a DIFFERENT suburb before resolving.
        // The street-segment `address` branch above intentionally drops the
        // suburb, so a "23 Glyde St, Mosman Park" search can match "23 Glyde St,
        // East Fremantle" (a sibling Verge Valet sub-client); a lone match would
        // then auto-resolve to the wrong council's area. Only geocoded rows with
        // a positively-conflicting suburb are dropped — un-geocoded imports stay.
        const scoped = filterBySuburbAgreement(
          (data ?? []) as unknown as EligiblePropertyRow[],
          extractSuburb(s)
        )
        if (scoped.length > 0 && rowsAreSameProperty(scoped)) {
          return scoped[0]!
        }
        return null
      }

      // Multi-pass ILIKE: Google's Geocoding API and Places Autocomplete
      // disagree on canonical form (Street vs St, Unit-prefix, etc.). The
      // candidate list covers raw, premise-stripped, street-type-abbreviated,
      // and both transforms combined — see buildLookupCandidates.
      const candidates = buildLookupCandidates(searchStr, stripAddressPrefix)
      let property: EligiblePropertyRow | null = null
      for (const candidate of candidates) {
        property = await tryLookup(
          candidate,
          candidate === searchStr ? placeId : undefined
        )
        if (property) break
      }

      if (!property) {
        setNotFound(true)
        return
      }

      // Staged go-live gate (WS-A): the area must be active to book on the new
      // system. Held-back councils resolve to "not yet available" rather than
      // "not eligible". create-booking enforces the same check server-side.
      if (!isAreaBookable(property.collection_area)) {
        setNotYetAvailable(true)
        return
      }

      // MUD redirect check via the pure decision helper
      const candidate: MudLookupCandidate = {
        id: property.id,
        formatted_address: property.formatted_address,
        address: property.address,
        is_mud: property.is_mud,
        is_eligible: property.is_eligible,
      }
      const decision = decideMudRedirect([candidate])
      if (decision.redirect) {
        setMudRedirect({
          building_address: decision.building_address ?? property.address,
        })
        return
      }

      setSelectedProperty(property)
    },
    [supabase, clientId]
  )

  // Auto-resolve address from search params on mount
  useEffect(() => {
    if (initialAddress && !hasAutoResolved) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot guard flag for auto-resolve on mount; initialAddress derives from searchParams
      setHasAutoResolved(true)
      void lookupProperty(initialAddress)
    }
  }, [initialAddress, hasAutoResolved, lookupProperty])

  // Fetch FY allocation at category level when a property is selected
  const { data: allocationData, isLoading: allocationLoading } = useQuery({
    queryKey: ['allocations', selectedProperty?.id],
    enabled: !!selectedProperty,
    queryFn: async () => {
      if (!selectedProperty) return null

      const { data: fy } = await supabase
        .from('financial_year')
        .select('id, label')
        .eq('is_current', true)
        .single()

      if (!fy) return null

      if (!selectedProperty.collection_area_id) return null

      const { data: rules } = await supabase
        .from('allocation_rules')
        .select('max_collections, category!inner(name, code)')
        .eq('collection_area_id', selectedProperty.collection_area_id!)

      // FY usage via the authoritative SECURITY DEFINER RPC (§21): this page is
      // public, so a direct booking_item read is RLS-scoped to the viewer — an
      // anonymous resident would see zero usage (full availability) here even
      // after exhausting their allocation. p_fy_id omitted → current FY.
      const { data: usageRows } = await supabase.rpc('get_property_fy_usage', {
        p_property_id: selectedProperty.id,
      })

      const usageByCode = new Map<string, number>()
      for (const row of usageRows ?? []) {
        if (row.usage_kind === 'category') {
          usageByCode.set(row.usage_key, Number(row.units))
        }
      }

      // Admin allocation top-ups (allocation_override) via the companion DEFINER
      // RPC — the table's SELECT policy is staff-only, so a direct read returns
      // zero for residents and a granted top-up would show "0 remaining" here
      // while the wizard (already on this RPC) shows the topped-up count.
      const { data: overrideRows } = await supabase.rpc(
        'get_property_allocation_overrides',
        { p_property_id: selectedProperty.id }
      )

      // Overrides are per-service; roll up to category for the panel's tiles.
      const extraByCode = new Map<string, number>()
      if (overrideRows && overrideRows.length > 0) {
        const { data: services } = await supabase
          .from('service')
          .select('id, category!inner(code)')
          .in('id', overrideRows.map((r) => r.service_id))
        const codeByServiceId = new Map(
          (services ?? []).map((s) => {
            const cat = s.category as unknown as { code: string }
            return [s.id, cat.code] as const
          })
        )
        for (const r of overrideRows) {
          const code = codeByServiceId.get(r.service_id)
          if (code) {
            extraByCode.set(code, (extraByCode.get(code) ?? 0) + Number(r.extra_allocations))
          }
        }
      }

      const allocations = (rules ?? []).map((rule) => {
        const cat = rule.category as unknown as { name: string; code: string }
        const used = usageByCode.get(cat.code) ?? 0
        const maxCollections = rule.max_collections + (extraByCode.get(cat.code) ?? 0)
        return {
          categoryName: cat.name,
          code: cat.code,
          maxCollections,
          used: Math.min(used, maxCollections),
          remaining: Math.max(0, maxCollections - used),
        }
      })

      const { data: bookings } = await supabase
        .from('booking')
        .select('ref, status, created_at')
        .eq('property_id', selectedProperty.id)
        .eq('fy_id', fy.id)
        .not('status', 'in', '("Cancelled","Pending Payment")')
        .order('created_at', { ascending: false })
        .limit(5)

      return { fy, allocations, bookings: bookings ?? [] }
    },
  })

  function handleAddressSelect(placeId: string, description: string) {
    void lookupProperty(description, placeId)
  }

  function handleContinue() {
    if (!selectedProperty || !selectedProperty.collection_area_id) return
    const params = new URLSearchParams({
      property_id: selectedProperty.id,
      collection_area_id: selectedProperty.collection_area_id,
      address: selectedProperty.formatted_address ?? selectedProperty.address,
      ...(onBehalf ? { on_behalf: 'true' } : {}),
    })
    router.push(`/book/services?${params.toString()}`)
  }

  // Imported geocode data is untrusted: finiteCoord rejects '', 'junk' and
  // other non-finite values that would otherwise pin the map at 0,0 or throw
  // inside Leaflet (L.map with a NaN center).
  const propertyLat = selectedProperty?.has_geocode
    ? finiteCoord(selectedProperty.latitude)
    : null
  const propertyLng = selectedProperty?.has_geocode
    ? finiteCoord(selectedProperty.longitude)
    : null

  return (
    <div className="flex flex-col">
      <BookingStepper currentStep={1} />

      {/* Content */}
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto pb-24 pt-6">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-title font-bold leading-tight text-[var(--brand)]">
            Book a collection
          </h1>
          <p className="mt-1 text-body-sm leading-relaxed text-gray-500">
            Enter your property address to check eligibility and view
            allocations.
          </p>
        </div>

        {/* Search card — full width */}
        <div className="rounded-xl bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-700">
              Search your property address
            </label>
            <AddressAutocomplete
              onSelect={handleAddressSelect}
              placeholder="Start typing your address..."
              initialValue={initialAddress}
            />
          </div>

          {/* Property found banner */}
          {selectedProperty && (
            <div role="alert" className="mt-3 flex items-center gap-2.5 rounded-[10px] border border-[var(--brand-accent-dark)] bg-[var(--brand-accent-light)] px-4 py-3 text-body-sm font-medium text-[#006A38]">
              <span className="shrink-0 text-base" aria-hidden="true">&#10003;</span>
              <div>
                <div className="font-semibold">Property found!</div>
                <div className="mt-px text-xs font-normal">
                  This property qualifies for {serviceName} collection services.
                </div>
              </div>
            </div>
          )}

          {/* Not found */}
          {notFound && (
            <div role="alert" className="mt-3 flex items-center gap-2.5 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-body-sm font-medium text-red-700">
              <span className="shrink-0 text-base" aria-hidden="true">&#10007;</span>
              <div>
                <div className="font-semibold">Address not eligible</div>
                <div className="mt-px text-xs font-normal">
                  This address is not eligible for {serviceName} collection
                  services. Please contact your local council for further
                  details.
                </div>
              </div>
            </div>
          )}

          {/* Not yet available — area exists but its council isn't live online yet (WS-A) */}
          {notYetAvailable && (
            <div role="alert" className="mt-3 flex items-center gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-body-sm font-medium text-amber-800">
              <span className="shrink-0 text-base" aria-hidden="true">&#8987;</span>
              <div>
                <div className="font-semibold">Not yet available online</div>
                <div className="mt-px text-xs font-normal">
                  Online bookings for this area aren&rsquo;t open yet. Please
                  contact your local council to arrange a collection.
                </div>
              </div>
            </div>
          )}

          {/* MUD redirect — block individual bookings, point to strata manager */}
          {mudRedirect && (
            <div className="mt-3 rounded-[10px] border border-[#805AD5] bg-[#F3EEFF] px-4 py-4 text-[13px] text-[#293F52]">
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 shrink-0 text-base">&#x1F3E2;</span>
                <div className="flex-1">
                  <div className="font-semibold text-[#5B348B]">
                    Multi-unit property
                  </div>
                  <p className="mt-1 leading-relaxed">
                    Collections for <strong>{mudRedirect.building_address}</strong> are
                    arranged centrally — please contact your strata manager or building
                    manager to organise a collection.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Loading state for allocation data */}
        {selectedProperty && allocationLoading && (
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl bg-white px-4 py-12 shadow-sm">
            <Spinner size="md" />
            <p className="text-sm text-gray-500">Loading allocation data...</p>
          </div>
        )}

        {/* Two-column grid: Map (left) + Allocations (right) */}
        {selectedProperty && allocationData && !allocationLoading && (
          <div className="grid gap-4 md:grid-cols-2">
            {/* Left: Property location + map */}
            <div className="overflow-hidden rounded-xl bg-white shadow-sm">
              <div className="flex items-center gap-2.5 px-4 py-3.5">
                <span className="text-base text-[var(--brand-accent-dark)]" aria-hidden="true">&#x1F4CD;</span>
                <div>
                  <div className="text-body-sm font-semibold text-[var(--brand)]">
                    Property location
                  </div>
                  <div className="mt-px text-xs text-[var(--brand-accent-dark)]">
                    {selectedProperty.formatted_address ??
                      selectedProperty.address}
                  </div>
                </div>
              </div>

              {/* Map or placeholder */}
              {propertyLat !== null && propertyLng !== null ? (
                <PropertyMap
                  lat={propertyLat}
                  lng={propertyLng}
                  address={
                    selectedProperty.formatted_address ??
                    selectedProperty.address
                  }
                />
              ) : (
                <div className="flex h-[190px] flex-col items-center justify-center gap-1 bg-[#dde8d4]">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#7A7A7A"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                    <circle cx="12" cy="10" r="3" />
                  </svg>
                  <span className="text-xs text-gray-500">
                    Map unavailable &mdash; geocode pending
                  </span>
                </div>
              )}
            </div>

            {/* Right: Allocation tiles + Book button */}
            <div className="rounded-xl bg-white p-6 shadow-sm">
              <div className="mb-3.5 flex items-center gap-2">
                <span className="text-base" aria-hidden="true">&#x1F4E6;</span>
                <span className="font-[family-name:var(--font-heading)] text-sm font-semibold text-[var(--brand)]">
                  Service allocations &mdash;{' '}
                  {formatFinancialYearLabel(allocationData.fy.label)}
                </span>
              </div>

              <div className="flex flex-col gap-2">
                {allocationData.allocations.map((alloc) => (
                  <div
                    key={alloc.code}
                    className="flex items-center justify-between rounded-[10px] border-[1.5px] border-gray-100 bg-gray-50 px-3.5 py-3"
                  >
                    <div>
                      <div className="text-sm font-semibold text-gray-900">
                        {alloc.categoryName}
                      </div>
                      <div className="mt-0.5 text-caption text-gray-500">
                        {alloc.used} of {alloc.maxCollections} included used
                      </div>
                    </div>
                    <div
                      className={`whitespace-nowrap rounded-full border px-3 py-1 text-caption font-medium ${
                        alloc.remaining > 0
                          ? 'border-[var(--brand-accent-dark)] bg-[var(--brand-accent-light)] text-[#006A38]'
                          : 'border-[#E53E3E] bg-[#FFF0F0] text-[#E53E3E]'
                      }`}
                    >
                      {alloc.remaining} remaining
                    </div>
                  </div>
                ))}
              </div>

              <VercoButton type="button" onClick={handleContinue} className="mt-4 w-full">
                Book new collection &rarr;
              </VercoButton>
            </div>
          </div>
        )}

        {/* Booking history — full width below the grid */}
        {selectedProperty && allocationData && !allocationLoading && (
          <div className="rounded-xl bg-white p-6 shadow-sm">
            <div className="mb-3 flex items-center gap-2">
              <span className="text-base" aria-hidden="true">&#x1F550;</span>
              <span className="font-[family-name:var(--font-heading)] text-sm font-semibold text-[var(--brand)]">
                Booking history &mdash;{' '}
                {formatFinancialYearLabel(allocationData.fy.label)}
              </span>
            </div>

            {allocationData.bookings.length === 0 ? (
              <div className="flex items-center gap-2.5">
                <span className="text-base text-[var(--brand-accent-dark)]" aria-hidden="true">&#10003;</span>
                <span className="text-body-sm text-gray-500">
                  No bookings yet for this financial year.
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {allocationData.bookings.map((booking) => (
                  <div
                    key={booking.ref}
                    className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2.5"
                  >
                    <div>
                      <div className="text-body-sm font-medium text-gray-900">
                        {booking.ref}
                      </div>
                      <div className="text-caption text-gray-500">
                        {new Date(booking.created_at).toLocaleDateString(
                          'en-AU',
                          { day: 'numeric', month: 'short', year: 'numeric' }
                        )}
                      </div>
                    </div>
                    <span className="rounded-full bg-gray-50 px-2.5 py-1 text-caption font-medium text-gray-700">
                      {booking.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
