'use client'

import { useState, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { format } from 'date-fns'
import { createMudBooking } from './actions'
import { clientHasTerms } from '@/lib/booking/terms'
import { TermsAcceptanceDialog } from '@/app/(public)/book/confirm/terms-acceptance-dialog'
import type { MudAllowanceServiceResult } from '@/lib/mud/allowance'

export interface ServiceOption {
  service_id: string
  name: string
  category_code: string
  max_collections_per_unit: number
}

export interface DateOption {
  id: string
  date: string
  bulk_remaining: number
  bulk_closed: boolean
  anc_remaining: number
  anc_closed: boolean
  id_remaining: number
  id_closed: boolean
}

interface MudBookingFormProps {
  property: {
    id: string
    formatted_address: string
    mud_code: string | null
    unit_count: number
    waste_location_notes: string | null
    area_code: string
    area_name: string
  }
  strataContact: {
    id: string
    full_name: string
    mobile_e164: string | null
    email: string
  }
  services: ServiceOption[]
  allowanceSummary: MudAllowanceServiceResult[]
  dates: DateOption[]
  mudUnitsPerService: number
  termsMarkdown: string | null
}

export function MudBookingForm({
  property,
  strataContact,
  services,
  allowanceSummary,
  dates,
  mudUnitsPerService,
  termsMarkdown,
}: MudBookingFormProps) {
  const router = useRouter()
  const [selectedDateId, setSelectedDateId] = useState('')
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set())
  const [notes, setNotes] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // T&Cs gate — staff acknowledge on the resident's behalf before submit.
  const [showTerms, setShowTerms] = useState(false)
  const termsAcceptedRef = useRef(false)

  const allowanceByService = useMemo(() => {
    const map = new Map<string, MudAllowanceServiceResult>()
    for (const a of allowanceSummary) map.set(a.service_id, a)
    return map
  }, [allowanceSummary])

  const selectedDate = dates.find((d) => d.id === selectedDateId)

  function toggleService(serviceId: string) {
    setSelectedServices((prev) => {
      const next = new Set(prev)
      if (next.has(serviceId)) next.delete(serviceId)
      else next.add(serviceId)
      return next
    })
  }

  // Per-bucket units this booking would add (for capacity hint)
  const bucketLoad = useMemo(() => {
    const load = { bulk: 0, anc: 0, id: 0 }
    for (const s of services) {
      if (!selectedServices.has(s.service_id)) continue
      const code = s.category_code as 'bulk' | 'anc' | 'id'
      load[code] = (load[code] ?? 0) + mudUnitsPerService
    }
    return load
  }, [services, selectedServices, mudUnitsPerService])

  const dateCapacityWarning = useMemo(() => {
    if (!selectedDate) return null
    const issues: string[] = []
    if (bucketLoad.bulk > 0 && (selectedDate.bulk_closed || selectedDate.bulk_remaining < bucketLoad.bulk)) {
      issues.push(`Bulk: needs ${bucketLoad.bulk}, ${selectedDate.bulk_closed ? 'closed' : `${selectedDate.bulk_remaining} remaining`}`)
    }
    if (bucketLoad.anc > 0 && (selectedDate.anc_closed || selectedDate.anc_remaining < bucketLoad.anc)) {
      issues.push(`Ancillary: needs ${bucketLoad.anc}, ${selectedDate.anc_closed ? 'closed' : `${selectedDate.anc_remaining} remaining`}`)
    }
    if (bucketLoad.id > 0 && (selectedDate.id_closed || selectedDate.id_remaining < bucketLoad.id)) {
      issues.push(`Illegal dumping: needs ${bucketLoad.id}, ${selectedDate.id_closed ? 'closed' : `${selectedDate.id_remaining} remaining`}`)
    }
    return issues.length > 0 ? issues : null
  }, [selectedDate, bucketLoad])

  // Per-service allowance hint for currently selected services
  const allowanceWarning = useMemo(() => {
    const issues: string[] = []
    for (const sid of selectedServices) {
      const a = allowanceByService.get(sid)
      if (!a) continue
      const wouldUse = a.used + mudUnitsPerService
      if (wouldUse > a.total_cap) {
        issues.push(`${a.service_name}: would use ${wouldUse}/${a.total_cap}`)
      }
    }
    return issues.length > 0 ? issues : null
  }, [selectedServices, allowanceByService, mudUnitsPerService])

  const canSubmit =
    selectedDateId &&
    selectedServices.size > 0 &&
    !dateCapacityWarning &&
    !allowanceWarning &&
    !isSubmitting

  async function handleSubmit() {
    if (!canSubmit) return

    // T&Cs gate — acknowledge before creating the booking. Empty terms ⇒ skipped.
    if (clientHasTerms(termsMarkdown) && !termsAcceptedRef.current) {
      setShowTerms(true)
      return
    }

    setError(null)
    setIsSubmitting(true)
    try {
      const result = await createMudBooking({
        property_id: property.id,
        collection_date_id: selectedDateId,
        service_ids: Array.from(selectedServices),
        notes: notes.trim() || null,
        terms_accepted: termsAcceptedRef.current,
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      router.push(`/admin/bookings/${result.data.booking_id}`)
      router.refresh()
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <Link
          href={`/admin/properties/${property.id}`}
          className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-[#293F52]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Property
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
              New MUD booking
            </h1>
            <p className="mt-0.5 text-body-sm text-gray-500">
              {property.formatted_address}
            </p>
          </div>
          {property.mud_code && (
            <span className="rounded-full bg-[#F3EEFF] px-3 py-1 text-caption font-semibold text-[#805AD5]">
              {property.mud_code} · {property.unit_count}u
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-[#F8F9FA] px-7 py-5">
        <div className="mx-auto max-w-2xl space-y-5">
          {/* Pre-filled context — read only */}
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <h2 className="text-caption font-semibold uppercase tracking-wide text-gray-500">
              Pre-filled from MUD record
            </h2>
            <div className="mt-3 grid grid-cols-2 gap-4 text-body-sm">
              <div>
                <div className="text-caption font-semibold text-gray-500">Strata contact</div>
                <div className="mt-0.5 text-[#293F52]">{strataContact.full_name}</div>
                <div className="text-xs text-gray-500">{strataContact.email}</div>
                {strataContact.mobile_e164 && (
                  <div className="text-xs text-gray-500">{strataContact.mobile_e164}</div>
                )}
              </div>
              <div>
                <div className="text-caption font-semibold text-gray-500">Waste location</div>
                <div className="mt-0.5 whitespace-pre-wrap text-[#293F52]">
                  {property.waste_location_notes || '—'}
                </div>
              </div>
            </div>
          </div>

          {/* Service selection */}
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <h2 className="text-caption font-semibold uppercase tracking-wide text-gray-500">
              Services
            </h2>
            <p className="mt-1 text-caption text-gray-500">
              Each service consumes {mudUnitsPerService} placeholder units of the day&apos;s
              capacity. Allowance figures show this MUD&apos;s current FY usage.
            </p>
            {services.length === 0 ? (
              <p className="mt-3 text-xs text-gray-400">No services configured for this area.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {services.map((s) => {
                  const allowance = allowanceByService.get(s.service_id)
                  const isSelected = selectedServices.has(s.service_id)
                  const wouldUse = (allowance?.used ?? 0) + mudUnitsPerService
                  const cap = allowance?.total_cap ?? property.unit_count * s.max_collections_per_unit
                  const exceedsCap = isSelected && wouldUse > cap
                  return (
                    <label
                      key={s.service_id}
                      className={`flex cursor-pointer items-center justify-between rounded-lg border-[1.5px] px-3 py-2.5 ${
                        exceedsCap
                          ? 'border-red-300 bg-red-50'
                          : isSelected
                          ? 'border-[#293F52] bg-[#F3F8FF]'
                          : 'border-gray-100 bg-white hover:border-gray-200'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleService(s.service_id)}
                          className="h-4 w-4 rounded border-gray-300"
                        />
                        <div>
                          <div className="text-body-sm font-medium text-[#293F52]">{s.name}</div>
                          <div className="text-caption text-gray-500">
                            {s.category_code} · cap {cap} per FY
                          </div>
                        </div>
                      </div>
                      <div className="text-right text-caption">
                        <div className={exceedsCap ? 'font-semibold text-red-700' : 'text-gray-500'}>
                          {allowance?.used ?? 0} used
                        </div>
                        {isSelected && (
                          <div className={exceedsCap ? 'text-red-700' : 'text-emerald-600'}>
                            +{mudUnitsPerService} → {wouldUse}
                          </div>
                        )}
                      </div>
                    </label>
                  )
                })}
              </div>
            )}
            {allowanceWarning && (
              <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                <div className="font-semibold">Allowance would be exceeded:</div>
                <ul className="mt-1 list-disc pl-4">
                  {allowanceWarning.map((w) => <li key={w}>{w}</li>)}
                </ul>
                <p className="mt-2 text-caption">
                  Contact D&amp;M admin for an allowance grant.
                </p>
              </div>
            )}
          </div>

          {/* Collection date */}
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <h2 className="text-caption font-semibold uppercase tracking-wide text-gray-500">
              Collection date
            </h2>
            <p className="mt-1 text-caption text-gray-500">
              MUD-enabled dates within the next 12 months for {property.area_code}.
            </p>
            {dates.length === 0 ? (
              <p className="mt-3 text-xs text-gray-400">
                No MUD collection dates available for this area in the next 12 months.
              </p>
            ) : (
              <select
                value={selectedDateId}
                onChange={(e) => setSelectedDateId(e.target.value)}
                className="mt-3 w-full rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-2.5 text-body-sm outline-none focus:border-[#293F52]"
              >
                <option value="">Select a date...</option>
                {dates.map((d) => (
                  <option key={d.id} value={d.id}>
                    {format(new Date(d.date + 'T00:00:00'), 'EEEE d MMMM yyyy')}
                    {' — bulk '}
                    {d.bulk_closed ? 'closed' : `${d.bulk_remaining} left`}
                  </option>
                ))}
              </select>
            )}
            {dateCapacityWarning && (
              <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                <div className="font-semibold">Day capacity insufficient:</div>
                <ul className="mt-1 list-disc pl-4">
                  {dateCapacityWarning.map((w) => <li key={w}>{w}</li>)}
                </ul>
                <p className="mt-2 text-caption">Choose a different date or wait for capacity to free up.</p>
              </div>
            )}
          </div>

          {/* Notes */}
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <h2 className="text-caption font-semibold uppercase tracking-wide text-gray-500">
              Notes (optional)
            </h2>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything the crew needs to know about this collection"
              className="mt-3 h-20 w-full resize-none rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-2 text-body-sm outline-none placeholder:text-gray-400 focus:border-[#293F52]"
              maxLength={500}
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Link
              href={`/admin/properties/${property.id}`}
              className="rounded-lg border-[1.5px] border-gray-100 bg-white px-4 py-2 text-body-sm font-semibold text-[#293F52] transition-colors hover:bg-gray-50"
            >
              Cancel
            </Link>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="rounded-lg bg-[#293F52] px-4 py-2 text-body-sm font-semibold text-white transition-colors hover:bg-[#1e3040] disabled:opacity-50"
            >
              {isSubmitting ? 'Creating booking...' : 'Create MUD booking'}
            </button>
          </div>
        </div>
      </div>

      {termsMarkdown && (
        <TermsAcceptanceDialog
          open={showTerms}
          termsMarkdown={termsMarkdown}
          onCancel={() => setShowTerms(false)}
          onAccept={() => {
            termsAcceptedRef.current = true
            setShowTerms(false)
            void handleSubmit()
          }}
        />
      )}
    </div>
  )
}
