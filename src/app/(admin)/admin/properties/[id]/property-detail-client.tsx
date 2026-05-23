'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { BookingStatusBadge } from '@/components/booking/booking-status-badge'
import { getStatusStyle } from '@/lib/ui/status-styles'
import { AllocationFormModal } from '@/app/(admin)/admin/allocations/allocation-form-modal'
import { MudDetailSection } from './mud-detail-section'
import type { ResolvedAuditEntry } from '@/lib/audit/resolve'
import { AuditTimeline } from '@/components/audit-timeline'

/* ------------------------------------------------------------------ */
/*  Props — shaped by what page.tsx actually passes                    */
/* ------------------------------------------------------------------ */

type StrataContact = {
  id: string
  first_name: string
  last_name: string
  full_name: string
  mobile_e164: string | null
  email: string
} | null

interface PropertyDetailClientProps {
  property: {
    id: string
    address: string
    formatted_address: string | null
    is_mud: boolean
    is_eligible: boolean
    collection_area_id: string | null
    collection_area: { id: string; name: string; code: string }
    // MUD fields (nullable when is_mud=false)
    unit_count: number
    mud_code: string | null
    mud_onboarding_status: 'Contact Made' | 'Registered' | 'Inactive' | null
    collection_cadence: 'Ad-hoc' | 'Annual' | 'Bi-annual' | 'Quarterly' | null
    waste_location_notes: string | null
    auth_form_url: string | null
    strata_contact: StrataContact | StrataContact[] | null
  }
  fy: { id: string; label: string }
  nextExpected: { last_date: string | null; next_expected_date: string | null } | null
  authFormSignedUrl: string | null
  bookings: Array<{
    id: string
    ref: string
    status: string
    type: string
    created_at: string
    contact: { full_name: string } | null
    booking_item: Array<{
      no_services: number
      service: { name: string }
      collection_date: { date: string }
    }>
  }>
  ncns: Array<{
    id: string
    status: string
    contractor_fault: boolean
    reported_at: string
    booking: { id: string; ref: string } | null
  }>
  nps: Array<{
    id: string
    status: string
    contractor_fault: boolean
    reported_at: string
    booking: { id: string; ref: string } | null
  }>
  serviceTickets: Array<{
    id: string
    display_id: string
    subject: string
    status: string
    created_at: string
  }>
  allocationOverrides: Array<{
    id: string
    extra_allocations: number
    reason: string
    created_at: string
    service: { name: string; category: { name: string } }
    created_by: string
  }>
  allocationRules: Array<{
    max_collections: number
    category: { name: string; code: string }
  }>
  fyUsage: Array<{
    no_services: number
    service: { category: { code: string } }
    booking: { property_id: string | null; fy_id: string; status: string }
  }>
  auditLogs: ResolvedAuditEntry[]
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function buildAllocations(
  rules: PropertyDetailClientProps['allocationRules'],
  overrides: PropertyDetailClientProps['allocationOverrides'],
  usage: PropertyDetailClientProps['fyUsage'],
  isMud: boolean,
  unitCount: number,
) {
  const unitMultiplier = isMud && unitCount > 0 ? unitCount : 1
  return rules.map((rule) => {
    const cat = rule.category as { name: string; code: string }
    const used = usage
      .filter((u) => {
        const svc = u.service as { category: { code: string } }
        return svc.category.code === cat.code
      })
      .reduce((sum, u) => sum + u.no_services, 0)
    const extra = overrides
      .filter((o) => {
        const svc = o.service as { name: string; category: { name: string } }
        return svc.category.name === cat.name
      })
      .reduce((sum, o) => sum + o.extra_allocations, 0)
    const baseMax = rule.max_collections * unitMultiplier
    const max = baseMax + extra
    const remaining = Math.max(0, max - used)
    return { categoryName: cat.name, code: cat.code, max, baseMax, councilRule: rule.max_collections, used, extra, remaining }
  })
}

function formatServices(
  items: Array<{ no_services: number; service: { name: string } }>
) {
  const grouped = new Map<string, number>()
  for (const item of items) {
    const name = (item.service as { name: string }).name
    grouped.set(name, (grouped.get(name) ?? 0) + item.no_services)
  }
  return Array.from(grouped.entries())
    .map(([name, qty]) => `${name} \u00d7${qty}`)
    .join(', ')
}

function earliestDate(
  items: Array<{ collection_date: { date: string } }>
): string | null {
  if (items.length === 0) return null
  const dates = items.map(
    (i) => (i.collection_date as { date: string }).date
  )
  dates.sort()
  return dates[0] ?? null
}

/* ------------------------------------------------------------------ */
/*  Section heading                                                   */
/* ------------------------------------------------------------------ */

function SectionHeading({
  children,
  count,
  action,
}: {
  children: React.ReactNode
  count?: number
  action?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between pb-3">
      <h2 className="font-[family-name:var(--font-heading)] text-body font-bold text-[#293F52]">
        {children}
        {count !== undefined && (
          <span className="ml-2 text-body-sm font-normal text-gray-400">
            ({count})
          </span>
        )}
      </h2>
      {action}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export function PropertyDetailClient({
  property,
  fy,
  bookings,
  ncns,
  nps,
  serviceTickets,
  allocationOverrides,
  allocationRules,
  fyUsage,
  nextExpected,
  authFormSignedUrl,
  auditLogs,
}: PropertyDetailClientProps) {
  const queryClient = useQueryClient()
  const [showAllocationModal, setShowAllocationModal] = useState(false)

  // Strata contact may arrive as object or single-element array depending on
  // the Supabase select shape — normalise to a single value (or null).
  const strataContact: StrataContact = Array.isArray(property.strata_contact)
    ? (property.strata_contact[0] ?? null)
    : (property.strata_contact ?? null)

  const allocations = buildAllocations(allocationRules, allocationOverrides, fyUsage, property.is_mud, property.unit_count)

  const openNcns = ncns.filter((n) =>
    ['Issued', 'Disputed', 'Under Review'].includes(n.status)
  ).length
  const openNps = nps.filter((n) =>
    ['Issued', 'Disputed', 'Under Review'].includes(n.status)
  ).length
  const openTickets = serviceTickets.filter((t) =>
    ['open', 'in_progress'].includes(t.status)
  ).length

  const issues = [
    ...ncns.map((n) => ({ ...n, _type: 'NCN' as const })),
    ...nps.map((n) => ({ ...n, _type: 'NP' as const })),
  ]

  return (
    <>
      {/* ── 1. Header bar ─────────────────────────────────────────── */}
      <div className="border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <Link
          href="/admin/properties"
          className="inline-flex items-center gap-1 text-body-sm text-gray-500 hover:text-gray-700"
        >
          &larr; Properties
        </Link>

        <h1 className="mt-2 font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
          {property.formatted_address ?? property.address}
        </h1>

        <p className="mt-0.5 text-body-sm text-gray-500">
          {property.collection_area.code} &mdash;{' '}
          {property.collection_area.name}
        </p>

        <div className="mt-2 flex items-center gap-2">
          {property.is_mud && (
            <span className="inline-flex items-center rounded-full bg-purple-50 px-2.5 py-0.5 text-[11px] font-semibold text-purple-700">
              MUD
            </span>
          )}
          {!property.is_eligible && (
            <span className="inline-flex items-center rounded-full bg-red-50 px-2.5 py-0.5 text-[11px] font-semibold text-red-700">
              Ineligible
            </span>
          )}
        </div>
      </div>

      {/* ── 2. Stats row ──────────────────────────────────────────── */}
      <div className="px-7 py-5">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard label="Bookings" value={bookings.length} />
          <StatCard label="Open NCNs" value={openNcns} />
          <StatCard label="Open NPs" value={openNps} />
          <StatCard label="Open Tickets" value={openTickets} />
        </div>
      </div>

      {/* ── 2b. MUD section (only shown for MUD properties) ──────── */}
      {property.is_mud && (
        <div className="px-7 pb-5">
          <MudDetailSection
            property={property}
            strataContact={strataContact}
            nextExpected={nextExpected}
            authFormSignedUrl={authFormSignedUrl}
          />
        </div>
      )}

      {/* ── 3. Allocations ────────────────────────────────────────── */}
      <div className="px-7 py-5">
        <div className="rounded-xl bg-white shadow-sm">
          <div className="px-5 pt-4">
            <SectionHeading
              action={
                <button
                  onClick={() => setShowAllocationModal(true)}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-body-sm font-medium text-[#293F52] hover:bg-gray-50"
                >
                  Add Allocation
                </button>
              }
            >
              Allocations &mdash; {fy.label}
            </SectionHeading>
          </div>

          {allocations.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-t border-gray-100">
                    <th className="px-5 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-gray-400">
                      Category
                    </th>
                    <th className="px-5 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-gray-400">
                      Max
                    </th>
                    <th className="px-5 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-gray-400">
                      Used
                    </th>
                    <th className="px-5 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-gray-400">
                      Extra
                    </th>
                    <th className="px-5 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-gray-400">
                      Remaining
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {allocations.map((a) => (
                    <tr
                      key={a.code}
                      className="border-t border-gray-50"
                    >
                      <td className="px-5 py-3 text-body-sm font-medium text-gray-900">
                        {a.categoryName}
                      </td>
                      <td className="px-5 py-3 text-body-sm text-gray-700">
                        {a.max}
                        {property.is_mud && property.unit_count > 0 && (
                          <span className="ml-1.5 text-[11px] text-gray-400">
                            ({a.councilRule} × {property.unit_count})
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-body-sm text-gray-700">
                        {a.used}
                      </td>
                      <td className="px-5 py-3 text-body-sm text-gray-700">
                        {a.extra > 0 ? `+${a.extra}` : '0'}
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                            a.remaining > 0
                              ? 'bg-emerald-50 text-emerald-700'
                              : 'bg-red-50 text-red-700'
                          }`}
                        >
                          {a.remaining}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="px-5 pb-4 text-body-sm text-gray-400">
              No allocation rules configured for this collection area.
            </p>
          )}
        </div>
      </div>

      {/* ── 4. Bookings table ─────────────────────────────────────── */}
      <div className="px-7 py-5">
        <div className="rounded-xl bg-white shadow-sm">
          <div className="px-5 pt-4">
            <SectionHeading count={bookings.length}>
              Bookings &mdash; {fy.label}
            </SectionHeading>
          </div>

          {bookings.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-t border-gray-100">
                    {['Ref', 'Status', 'Type', 'Date', 'Contact', 'Services'].map(
                      (h) => (
                        <th
                          key={h}
                          className="px-5 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-gray-400"
                        >
                          {h}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((b) => {
                    const date = earliestDate(b.booking_item)
                    const contact = b.contact as { full_name: string } | null
                    return (
                      <tr
                        key={b.id}
                        className="border-t border-gray-50"
                      >
                        <td className="px-5 py-3">
                          <Link
                            href={`/admin/bookings/${b.id}`}
                            className="font-[family-name:var(--font-heading)] text-body-sm font-semibold text-[#293F52] hover:underline"
                          >
                            {b.ref}
                          </Link>
                        </td>
                        <td className="px-5 py-3">
                          <BookingStatusBadge
                            status={b.status as Parameters<typeof BookingStatusBadge>[0]['status']}
                          />
                        </td>
                        <td className="px-5 py-3 text-body-sm text-gray-700">
                          {b.type}
                        </td>
                        <td className="px-5 py-3 text-body-sm text-gray-700">
                          {date
                            ? format(new Date(date), 'd MMM yyyy')
                            : '\u2014'}
                        </td>
                        <td className="px-5 py-3 text-body-sm text-gray-700">
                          {contact?.full_name ?? '\u2014'}
                        </td>
                        <td className="px-5 py-3 text-body-sm text-gray-700">
                          {formatServices(b.booking_item)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="px-5 pb-4 text-body-sm text-gray-400">
              No bookings for this property in {fy.label}
            </p>
          )}
        </div>
      </div>

      {/* ── 5. Issues (NCNs + NPs) ────────────────────────────────── */}
      {issues.length > 0 && (
        <div className="px-7 py-5">
          <div className="rounded-xl bg-white shadow-sm">
            <div className="px-5 pt-4">
              <SectionHeading count={issues.length}>Issues</SectionHeading>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-t border-gray-100">
                    {['Type', 'Booking', 'Status', 'Reported', 'Fault'].map(
                      (h) => (
                        <th
                          key={h}
                          className="px-5 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-gray-400"
                        >
                          {h}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {issues.map((issue) => {
                    const entity = issue._type === 'NCN' ? 'ncn' : 'np'
                    const ss = getStatusStyle(entity, issue.status)
                    const detailPath =
                      issue._type === 'NCN'
                        ? `/admin/non-conformance/${issue.id}`
                        : `/admin/nothing-presented/${issue.id}`
                    const booking = issue.booking as { id: string; ref: string } | null
                    return (
                      <tr
                        key={`${issue._type}-${issue.id}`}
                        className="border-t border-gray-50"
                      >
                        <td className="px-5 py-3">
                          <Link href={detailPath}>
                            <span
                              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                                issue._type === 'NCN'
                                  ? 'bg-red-50 text-red-700'
                                  : 'bg-amber-50 text-amber-700'
                              }`}
                            >
                              {issue._type}
                            </span>
                          </Link>
                        </td>
                        <td className="px-5 py-3">
                          {booking ? (
                            <Link
                              href={`/admin/bookings/${booking.id}`}
                              className="text-body-sm font-medium text-[#293F52] hover:underline"
                            >
                              {booking.ref}
                            </Link>
                          ) : (
                            <span className="text-body-sm text-gray-400">
                              {'\u2014'}
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${ss.bg} ${ss.text}`}
                          >
                            {ss.label}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-body-sm text-gray-700">
                          {format(new Date(issue.reported_at), 'd MMM yyyy')}
                        </td>
                        <td className="px-5 py-3">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                              issue.contractor_fault
                                ? 'bg-red-50 text-red-700'
                                : 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            {issue.contractor_fault ? 'Contractor' : 'Resident'}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── 6. Service tickets ────────────────────────────────────── */}
      {serviceTickets.length > 0 && (
        <div className="px-7 py-5">
          <div className="rounded-xl bg-white shadow-sm">
            <div className="px-5 pt-4">
              <SectionHeading count={serviceTickets.length}>
                Service Tickets
              </SectionHeading>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-t border-gray-100">
                    {['ID', 'Subject', 'Status', 'Created'].map((h) => (
                      <th
                        key={h}
                        className="px-5 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-gray-400"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {serviceTickets.map((t) => {
                    const ss = getStatusStyle('ticket', t.status)
                    return (
                      <tr
                        key={t.id}
                        className="border-t border-gray-50"
                      >
                        <td className="px-5 py-3">
                          <Link
                            href={`/admin/service-tickets/${t.id}`}
                            className="font-[family-name:var(--font-heading)] text-body-sm font-semibold text-[#293F52] hover:underline"
                          >
                            {t.display_id}
                          </Link>
                        </td>
                        <td className="px-5 py-3 text-body-sm text-gray-700">
                          {t.subject}
                        </td>
                        <td className="px-5 py-3">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${ss.bg} ${ss.text}`}
                          >
                            {ss.label}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-body-sm text-gray-700">
                          {format(new Date(t.created_at), 'd MMM yyyy')}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── 7. Allocation overrides ───────────────────────────────── */}
      {allocationOverrides.length > 0 && (
        <div className="px-7 pb-8">
          <div className="rounded-xl bg-white shadow-sm">
            <div className="px-5 pt-4">
              <SectionHeading>Allocation Overrides</SectionHeading>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-t border-gray-100">
                    {['Service', 'Extra', 'Reason', 'Created By', 'Date'].map(
                      (h) => (
                        <th
                          key={h}
                          className="px-5 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-gray-400"
                        >
                          {h}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {allocationOverrides.map((o) => {
                    const svc = o.service as {
                      name: string
                      category: { name: string }
                    }
                    return (
                      <tr
                        key={o.id}
                        className="border-t border-gray-50"
                      >
                        <td className="px-5 py-3 text-body-sm text-gray-900">
                          {svc.name}{' '}
                          <span className="text-gray-400">
                            ({svc.category.name})
                          </span>
                        </td>
                        <td className="px-5 py-3">
                          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700">
                            +{o.extra_allocations}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-body-sm text-gray-700">
                          {o.reason}
                        </td>
                        <td className="px-5 py-3 text-body-sm text-gray-500">
                          {o.created_by.slice(0, 8)}
                        </td>
                        <td className="px-5 py-3 text-body-sm text-gray-700">
                          {format(new Date(o.created_at), 'd MMM yyyy')}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Audit trail ──────────────────────────────────────────── */}
      {auditLogs.length > 0 && (
        <div className="px-7 py-5">
          <div className="rounded-xl bg-white shadow-sm">
            <AuditTimeline entries={auditLogs} />
          </div>
        </div>
      )}

      {/* ── Allocation form modal ─────────────────────────────────── */}
      <AllocationFormModal
        open={showAllocationModal}
        onOpenChange={setShowAllocationModal}
        onSave={() => {
          void queryClient.invalidateQueries()
        }}
        propertyId={property.id}
        propertyAddress={property.formatted_address ?? property.address}
      />
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Stat card                                                         */
/* ------------------------------------------------------------------ */

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border-[1.5px] border-gray-100 bg-white px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <p className="font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
        {value}
      </p>
    </div>
  )
}
