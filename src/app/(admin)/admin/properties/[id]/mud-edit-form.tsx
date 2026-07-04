'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  updateMudProperty,
  upsertStrataContact,
  createAuthFormUploadUrl,
} from '../actions'
import { COLLECTION_CADENCES, type CollectionCadence } from '@/lib/mud/validation'
import { FieldLabel, Input, Select, Textarea } from '@/components/admin/form'

type StrataContact = {
  id: string
  first_name: string
  last_name: string
  mobile_e164: string | null
  email: string
} | null

interface MudEditFormProps {
  property: {
    id: string
    collection_area_id: string | null
    unit_count: number
    mud_code: string | null
    collection_cadence: CollectionCadence | null
    waste_location_notes: string | null
    auth_form_url: string | null
  }
  strataContact: StrataContact
  onCancel: () => void
}

const auMobileRegex = /^(\+614\d{8}|04\d{8})$/

export function MudEditForm({ property, strataContact, onCancel }: MudEditFormProps) {
  const router = useRouter()
  const supabase = createClient()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [unitCount, setUnitCount] = useState(property.unit_count)
  const [mudCode, setMudCode] = useState(property.mud_code ?? '')
  const [cadence, setCadence] = useState<CollectionCadence>(
    property.collection_cadence ?? 'Quarterly'
  )
  const [wasteNotes, setWasteNotes] = useState(property.waste_location_notes ?? '')
  const [contactFirstName, setContactFirstName] = useState(strataContact?.first_name ?? '')
  const [contactLastName, setContactLastName] = useState(strataContact?.last_name ?? '')
  const [contactMobile, setContactMobile] = useState(strataContact?.mobile_e164 ?? '')
  const [contactEmail, setContactEmail] = useState(strataContact?.email ?? '')
  const [authFormPath, setAuthFormPath] = useState<string | null>(property.auth_form_url)
  const [authFormJustUploaded, setAuthFormJustUploaded] = useState<string | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !property.collection_area_id) return

    setError(null)
    setIsUploading(true)

    try {
      if (file.size > 10 * 1024 * 1024) {
        setError('File too large (max 10 MB).')
        return
      }
      const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic']
      if (!allowed.includes(file.type)) {
        setError('File must be PDF, JPG, PNG, or HEIC.')
        return
      }

      const urlResult = await createAuthFormUploadUrl(
        property.id,
        property.collection_area_id,
        file.name
      )
      if (!urlResult.ok) {
        setError(urlResult.error)
        return
      }

      const { error: uploadError } = await supabase.storage
        .from('mud-auth-forms')
        .uploadToSignedUrl(urlResult.data.path, urlResult.data.token, file)

      if (uploadError) {
        setError(`Upload failed: ${uploadError.message}`)
        return
      }

      setAuthFormPath(urlResult.data.path)
      setAuthFormJustUploaded(file.name)
    } finally {
      setIsUploading(false)
    }
  }

  async function handleSave() {
    setError(null)

    if (unitCount < 8) {
      setError('Unit count must be at least 8.')
      return
    }
    if (!mudCode.trim()) {
      setError('MUD code is required.')
      return
    }

    // Strata contact: all-or-nothing
    const anyContactField = contactFirstName || contactLastName || contactMobile || contactEmail
    let strataContactId: string | null = strataContact?.id ?? null

    if (anyContactField) {
      if (!contactFirstName.trim() || !contactLastName.trim()) {
        setError('Strata contact first and last name are required if any contact field is filled.')
        return
      }
      if (!auMobileRegex.test(contactMobile.trim())) {
        setError('Mobile must be an Australian number (04XX or +614XX).')
        return
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim())) {
        setError('Email must be valid.')
        return
      }
    }

    setIsSubmitting(true)
    try {
      if (anyContactField) {
        const contactResult = await upsertStrataContact({
          property_id: property.id,
          first_name: contactFirstName.trim(),
          last_name: contactLastName.trim(),
          mobile_e164: contactMobile.trim(),
          email: contactEmail.trim(),
        })
        if (!contactResult.ok) {
          setError(contactResult.error)
          return
        }
        strataContactId = contactResult.data.contact_id
      }

      const result = await updateMudProperty({
        property_id: property.id,
        unit_count: unitCount,
        mud_code: mudCode.trim().toUpperCase(),
        collection_cadence: cadence,
        waste_location_notes: wasteNotes.trim() || null,
        strata_contact_id: strataContactId,
        auth_form_url: authFormPath,
      })

      if (!result.ok) {
        setError(result.error)
        return
      }

      router.refresh()
      onCancel()
    } finally {
      setIsSubmitting(false)
    }
  }

  // MUD-field visual delta over the shared Input base (white fill inside cards).
  const mudField = 'bg-white py-2 placeholder:text-gray-400'

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel htmlFor="mud-unit-count" className="mb-0">
            Unit count
          </FieldLabel>
          <Input
            id="mud-unit-count"
            type="number"
            min={8}
            value={unitCount}
            onChange={(e) => setUnitCount(Number.parseInt(e.target.value, 10) || 0)}
            className={`mt-1 ${mudField}`}
          />
        </div>
        <div>
          <FieldLabel htmlFor="mud-code" className="mb-0">
            MUD code
          </FieldLabel>
          <Input
            id="mud-code"
            type="text"
            mono
            value={mudCode}
            onChange={(e) => setMudCode(e.target.value.toUpperCase())}
            className={`mt-1 ${mudField}`}
          />
        </div>
      </div>

      <div>
        <FieldLabel htmlFor="mud-cadence" className="mb-0">
          Cadence
        </FieldLabel>
        <Select
          id="mud-cadence"
          value={cadence}
          onChange={(e) => setCadence(e.target.value as CollectionCadence)}
          className={`mt-1 ${mudField}`}
        >
          {COLLECTION_CADENCES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </Select>
      </div>

      <div>
        <FieldLabel htmlFor="mud-waste-notes" className="mb-0">
          Waste location notes
        </FieldLabel>
        <Textarea
          id="mud-waste-notes"
          value={wasteNotes}
          onChange={(e) => setWasteNotes(e.target.value)}
          placeholder="e.g. Collect all from the corner of Eric and Gadson"
          className={`mt-1 h-20 resize-none ${mudField}`}
        />
      </div>

      <div className="rounded-xl border border-gray-100 p-3.5">
        <div className="mb-2 text-caption font-semibold uppercase tracking-wide text-gray-500">
          Strata contact
        </div>
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="text"
              aria-label="Strata contact first name"
              autoComplete="given-name"
              value={contactFirstName}
              onChange={(e) => setContactFirstName(e.target.value)}
              placeholder="First name"
              className={mudField}
            />
            <Input
              type="text"
              aria-label="Strata contact last name"
              autoComplete="family-name"
              value={contactLastName}
              onChange={(e) => setContactLastName(e.target.value)}
              placeholder="Last name"
              className={mudField}
            />
          </div>
          <Input
            type="tel"
            aria-label="Strata contact mobile"
            value={contactMobile}
            onChange={(e) => setContactMobile(e.target.value)}
            placeholder="Mobile (04XX or +614XX)"
            className={mudField}
          />
          <Input
            type="email"
            aria-label="Strata contact email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="Email"
            className={mudField}
          />
        </div>
      </div>

      <div className="rounded-xl border border-gray-100 p-3.5">
        <div className="mb-2 text-caption font-semibold uppercase tracking-wide text-gray-500">
          Authorisation form
        </div>
        {authFormPath ? (
          <div className="flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2 text-xs">
            <span className="truncate text-emerald-700">
              ✓ {authFormJustUploaded ?? 'Uploaded'}
            </span>
            <button
              type="button"
              onClick={() => {
                setAuthFormPath(null)
                setAuthFormJustUploaded(null)
                if (fileInputRef.current) fileInputRef.current.value = ''
              }}
              className="ml-2 text-caption font-medium text-emerald-600 hover:underline"
            >
              Replace
            </button>
          </div>
        ) : (
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.heic,application/pdf,image/jpeg,image/png,image/heic"
            onChange={handleFileSelect}
            disabled={isUploading}
            className="block w-full text-xs text-gray-500 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-gray-700"
          />
        )}
        {isUploading && <p className="mt-2 text-caption text-gray-500">Uploading...</p>}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={isSubmitting}
          className="flex-1 rounded-xl border-[1.5px] border-gray-100 bg-white px-3.5 py-2.5 text-body-sm font-semibold text-[#293F52]"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={isSubmitting || isUploading}
          className="flex-1 rounded-xl bg-[#293F52] px-3.5 py-2.5 text-body-sm font-semibold text-white disabled:opacity-50"
        >
          {isSubmitting ? 'Saving...' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}
