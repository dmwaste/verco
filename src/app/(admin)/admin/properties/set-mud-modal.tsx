'use client'

import { useState, useEffect, useRef } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { createClient } from '@/lib/supabase/client'
import {
  createMudProperty,
  upsertStrataContact,
  suggestMudCode,
  createAuthFormUploadUrl,
} from './actions'
import {
  COLLECTION_CADENCES,
  type CollectionCadence,
} from '@/lib/mud/validation'
import { FieldLabel, Input, Select, Textarea } from '@/components/admin/form'

interface SetMudModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  property: {
    id: string
    address: string
    formatted_address: string | null
    collection_area_id: string
    collection_area_code: string
  } | null
  onSuccess: () => void
}

const auMobileRegex = /^(\+614\d{8}|04\d{8})$/

export function SetMudModal({ open, onOpenChange, property, onSuccess }: SetMudModalProps) {
  const supabase = createClient()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [unitCount, setUnitCount] = useState(8)
  const [mudCode, setMudCode] = useState('')
  const [cadence, setCadence] = useState<CollectionCadence>('Quarterly')
  const [wasteNotes, setWasteNotes] = useState('')
  const [contactFirstName, setContactFirstName] = useState('')
  const [contactLastName, setContactLastName] = useState('')
  const [contactMobile, setContactMobile] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [authFormPath, setAuthFormPath] = useState<string | null>(null)
  const [authFormName, setAuthFormName] = useState<string | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset state + auto-suggest mud_code when the modal opens for a new property
  useEffect(() => {
    if (!open || !property) return
    setUnitCount(8)
    setCadence('Quarterly')
    setWasteNotes('')
    setContactFirstName('')
    setContactLastName('')
    setContactMobile('')
    setContactEmail('')
    setAuthFormPath(null)
    setAuthFormName(null)
    setError(null)

    void (async () => {
      const result = await suggestMudCode(property.collection_area_id)
      if (result.ok) setMudCode(result.data.mud_code)
      else setMudCode(`${property.collection_area_code}-MUD-01`)
    })()
  }, [open, property])

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !property) return

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
      setAuthFormName(file.name)
    } finally {
      setIsUploading(false)
    }
  }

  async function handleSubmit() {
    if (!property) return
    setError(null)

    // Client-side validation
    if (unitCount < 8) {
      setError('Unit count must be at least 8.')
      return
    }
    if (!mudCode.trim()) {
      setError('MUD code is required.')
      return
    }

    // Strata contact is optional at Contact Made stage, but if any contact
    // field is filled in then ALL must be filled in (and validated).
    const anyContactField = contactFirstName || contactLastName || contactMobile || contactEmail
    let strataContactId: string | null = null

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
      // Upsert strata contact if any
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

      const result = await createMudProperty({
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

      onSuccess()
      onOpenChange(false)
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!property) return null

  // MUD-field visual delta over the shared Input base (white fill inside cards).
  const mudField = 'bg-white py-2 placeholder:text-gray-400'

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Popup className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <Dialog.Title className="font-[family-name:var(--font-heading)] text-lg font-bold text-[#293F52]">
              Set as MUD
            </Dialog.Title>
            <p className="mt-1 text-body-sm text-gray-500">
              {property.formatted_address ?? property.address}
            </p>
            <p className="mt-3 text-xs text-gray-500">
              Creates a MUD record at <strong>Contact Made</strong> status. Fill in the strata
              contact + auth form now or later — the property becomes bookable only after it&apos;s
              promoted to <strong>Registered</strong>.
            </p>

            <div className="mt-5 space-y-4">
              {/* Unit count + MUD code */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <FieldLabel htmlFor="setmud-unit-count" className="mb-0">
                    Unit count <span className="text-red-500">*</span>
                  </FieldLabel>
                  <Input
                    id="setmud-unit-count"
                    type="number"
                    min={8}
                    value={unitCount}
                    onChange={(e) => setUnitCount(Number.parseInt(e.target.value, 10) || 0)}
                    className={`mt-1 ${mudField}`}
                  />
                  <p className="mt-1 text-caption text-gray-400">Minimum 8</p>
                </div>
                <div>
                  <FieldLabel htmlFor="setmud-code" className="mb-0">
                    MUD code <span className="text-red-500">*</span>
                  </FieldLabel>
                  <Input
                    id="setmud-code"
                    type="text"
                    mono
                    value={mudCode}
                    onChange={(e) => setMudCode(e.target.value.toUpperCase())}
                    className={`mt-1 ${mudField}`}
                  />
                  <p className="mt-1 text-caption text-gray-400">Auto-suggested</p>
                </div>
              </div>

              {/* Cadence */}
              <div>
                <FieldLabel htmlFor="setmud-cadence" className="mb-0">
                  Collection cadence <span className="text-red-500">*</span>
                </FieldLabel>
                <Select
                  id="setmud-cadence"
                  value={cadence}
                  onChange={(e) => setCadence(e.target.value as CollectionCadence)}
                  className={`mt-1 ${mudField}`}
                >
                  {COLLECTION_CADENCES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </Select>
              </div>

              {/* Waste location notes */}
              <div>
                <FieldLabel htmlFor="setmud-waste-notes" className="mb-0">
                  Waste location notes
                </FieldLabel>
                <Textarea
                  id="setmud-waste-notes"
                  value={wasteNotes}
                  onChange={(e) => setWasteNotes(e.target.value)}
                  placeholder="e.g. Collect all from the corner of Eric and Gadson"
                  className={`mt-1 h-20 resize-none ${mudField}`}
                />
                <p className="mt-1 text-caption text-gray-400">Required to mark Registered</p>
              </div>

              {/* Strata contact */}
              <div className="rounded-xl border border-gray-100 p-3.5">
                <div className="mb-2 text-caption font-semibold uppercase tracking-wide text-gray-500">
                  Strata contact
                </div>
                <p className="mb-3 text-caption text-gray-400">
                  All three required if marking Registered. Required for NCN dual-recipient
                  routing.
                </p>
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

              {/* Auth form upload */}
              <div className="rounded-xl border border-gray-100 p-3.5">
                <div className="mb-2 text-caption font-semibold uppercase tracking-wide text-gray-500">
                  Authorisation form
                </div>
                <p className="mb-3 text-caption text-gray-400">
                  PDF, JPG, PNG, or HEIC. Max 10 MB. Required to mark Registered.
                </p>
                {authFormPath ? (
                  <div className="flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2 text-xs">
                    <span className="truncate text-emerald-700">
                      ✓ {authFormName}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setAuthFormPath(null)
                        setAuthFormName(null)
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
                {isUploading && (
                  <p className="mt-2 text-caption text-gray-500">Uploading...</p>
                )}
              </div>

              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {error}
                </div>
              )}
            </div>

            <div className="mt-6 flex gap-2.5">
              <Dialog.Close
                className="flex-1 rounded-xl border-[1.5px] border-gray-100 bg-white px-3.5 py-3 font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]"
                disabled={isSubmitting}
              >
                Cancel
              </Dialog.Close>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={isSubmitting || isUploading}
                className="flex-1 rounded-xl bg-[#293F52] px-3.5 py-3 font-[family-name:var(--font-heading)] text-sm font-semibold text-white disabled:opacity-50"
              >
                {isSubmitting ? 'Saving...' : 'Save MUD'}
              </button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
