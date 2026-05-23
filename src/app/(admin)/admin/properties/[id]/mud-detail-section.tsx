'use client'

import { useState } from 'react'
import { format } from 'date-fns'
import { MudEditForm } from './mud-edit-form'
import { MudStatusActions } from './mud-status-actions'

type StrataContact = {
  id: string
  first_name: string
  last_name: string
  full_name: string
  mobile_e164: string | null
  email: string
} | null

type Property = {
  id: string
  is_mud: boolean
  unit_count: number
  mud_code: string | null
  mud_onboarding_status: 'Contact Made' | 'Registered' | 'Inactive' | null
  collection_cadence: 'Ad-hoc' | 'Annual' | 'Bi-annual' | 'Quarterly' | null
  waste_location_notes: string | null
  auth_form_url: string | null
  collection_area_id?: string | null
}

interface MudDetailSectionProps {
  property: Property
  strataContact: StrataContact
  nextExpected: { last_date: string | null; next_expected_date: string | null } | null
  authFormSignedUrl: string | null
}

const STATUS_STYLES: Record<string, string> = {
  'Contact Made': 'bg-gray-100 text-gray-700',
  Registered: 'bg-emerald-50 text-emerald-700',
  Inactive: 'bg-red-50 text-red-700',
}

export function MudDetailSection({
  property,
  strataContact,
  nextExpected,
  authFormSignedUrl,
}: MudDetailSectionProps) {
  const status = property.mud_onboarding_status ?? 'Contact Made'
  const statusClasses = STATUS_STYLES[status] ?? STATUS_STYLES['Contact Made']
  const [isEditing, setIsEditing] = useState(false)

  if (isEditing) {
    return (
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
            Edit MUD details
          </h2>
          <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${statusClasses}`}>
            {status}
          </span>
        </div>
        <MudEditForm
          property={{
            id: property.id,
            collection_area_id: property.collection_area_id ?? null,
            unit_count: property.unit_count,
            mud_code: property.mud_code,
            collection_cadence: property.collection_cadence,
            waste_location_notes: property.waste_location_notes,
            auth_form_url: property.auth_form_url,
          }}
          strataContact={strataContact}
          onCancel={() => setIsEditing(false)}
        />
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {/* ── Left card: MUD details + schedule + status actions ──── */}
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between">
          <h2 className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
            MUD onboarding
          </h2>
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${statusClasses}`}>
              {status}
            </span>
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="text-[11px] font-medium text-[#293F52] hover:underline"
            >
              Edit
            </button>
          </div>
        </div>

        <div className="mt-3 space-y-2.5 text-[13px]">
          <div className="flex justify-between">
            <span className="text-gray-500">MUD code</span>
            <span className="text-right font-mono text-[#293F52]">
              {property.mud_code ?? '—'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Unit count</span>
            <span className="text-right text-[#293F52]">{property.unit_count}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Cadence</span>
            <span className="text-right text-[#293F52]">
              {property.collection_cadence ?? '—'}
            </span>
          </div>
        </div>

        {/* Cadence-based reminders */}
        {property.collection_cadence && property.collection_cadence !== 'Ad-hoc' && (
          <div className="mt-4 rounded-lg bg-gray-50 p-3 text-[12px]">
            <div className="flex justify-between">
              <span className="text-gray-500">Last completed</span>
              <span className="text-[#293F52]">
                {nextExpected?.last_date
                  ? format(new Date(nextExpected.last_date + 'T00:00:00'), 'd MMM yyyy')
                  : '—'}
              </span>
            </div>
            <div className="mt-1.5 flex justify-between">
              <span className="text-gray-500">Next expected</span>
              <span className="text-[#293F52]">
                {nextExpected?.next_expected_date
                  ? format(new Date(nextExpected.next_expected_date + 'T00:00:00'), 'd MMM yyyy')
                  : status === 'Registered'
                  ? 'No bookings yet'
                  : 'Awaiting Registered'}
              </span>
            </div>
          </div>
        )}

        {/* Status transitions */}
        <div className="mt-6 border-t border-gray-100 pt-4">
          <MudStatusActions
            property={{
              id: property.id,
              is_mud: property.is_mud,
              unit_count: property.unit_count,
              strata_contact_id: strataContact?.id ?? null,
              auth_form_url: property.auth_form_url,
              waste_location_notes: property.waste_location_notes,
              collection_cadence: property.collection_cadence,
              mud_onboarding_status: property.mud_onboarding_status,
            }}
          />
        </div>
      </div>

      {/* ── Right card: contact + notes + auth form ─────────── */}
      <div className="rounded-xl bg-white p-5 shadow-sm">
        {/* Strata contact */}
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
            Strata contact
          </div>
          {strataContact ? (
            <div className="mt-2 space-y-1 text-[13px]">
              <div className="font-medium text-[#293F52]">{strataContact.full_name}</div>
              <div className="text-gray-600">{strataContact.email}</div>
              {strataContact.mobile_e164 && (
                <div className="text-gray-600">{strataContact.mobile_e164}</div>
              )}
            </div>
          ) : (
            <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
              Not set — required for Registered status
            </div>
          )}
        </div>

        {/* Waste location notes */}
        <div className="mt-5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
            Waste location notes
          </div>
          {property.waste_location_notes ? (
            <p className="mt-2 whitespace-pre-wrap text-[13px] text-[#293F52]">
              {property.waste_location_notes}
            </p>
          ) : (
            <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
              Not set — required for Registered status
            </div>
          )}
        </div>

        {/* Auth form */}
        <div className="mt-5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
            Authorisation form
          </div>
          {authFormSignedUrl ? (
            <a
              href={authFormSignedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-[12px] font-medium text-emerald-700 hover:bg-emerald-100"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              View auth form
            </a>
          ) : (
            <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
              Not uploaded — required for Registered status
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
