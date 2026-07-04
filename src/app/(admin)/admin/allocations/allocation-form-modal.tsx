'use client'

import { useState, useEffect } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Dialog } from '@base-ui/react/dialog'
import { createClient } from '@/lib/supabase/client'
import { VercoButton } from '@/components/ui/verco-button'
import { FieldLabel, Input, Select, Textarea } from '@/components/admin/form'

interface AllocationFormModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: () => void
  propertyId: string
  propertyAddress: string
  /**
   * When provided, the modal opens in "edit existing override" mode: the
   * service is locked and the form pre-fills from this row. Omit for the
   * add flow (service chosen in the modal, targeting the current FY).
   */
  editOverride?: {
    id: string
    service_id: string
    fy_id: string
    fy_label?: string
    extra_allocations: number
    reason: string
  }
}

export function AllocationFormModal({ open, onOpenChange, onSave, propertyId, propertyAddress, editOverride }: AllocationFormModalProps) {
  const supabase = createClient()
  const isEdit = !!editOverride
  const [userId, setUserId] = useState<string | null>(null)
  // Existing override row for the current (property, service, FY) combination.
  // Set → submit UPDATEs it; null → submit INSERTs a new row. Drives the
  // "one canonical row, no stacking" rule (VER-304).
  const [existingRowId, setExistingRowId] = useState<string | null>(null)
  const [formData, setFormData] = useState({
    service_id: '',
    extra_allocations: '',
    reason: '',
  })

  const [errors, setErrors] = useState<Record<string, string>>({})

  // Fetch current user ID for created_by
  useEffect(() => {
    async function fetchUser() {
      const { data } = await supabase.auth.getUser()
      if (data.user) setUserId(data.user.id)
    }
    void fetchUser()
  }, [supabase])

  // Fetch services with category info
  const { data: services } = useQuery({
    queryKey: ['services-with-category'],
    enabled: open,
    queryFn: async () => {
      const { data } = await supabase
        .from('service')
        .select('id, name, category!inner(name, code)')
        .order('name', { ascending: true })
      return data ?? []
    },
  })

  // Fetch current FY
  const { data: currentFy } = useQuery({
    queryKey: ['current-financial-year'],
    enabled: open,
    queryFn: async () => {
      const { data } = await supabase
        .from('financial_year')
        .select('id, label')
        .eq('is_current', true)
        .single()
      return data
    },
  })

  // Effective financial year: an edited row keeps its own FY (may be a past
  // FY visible in the list); the add flow always targets the current FY.
  const effectiveFyId = editOverride?.fy_id ?? currentFy?.id ?? null
  const effectiveFyLabel = editOverride?.fy_label ?? currentFy?.label ?? 'Loading...'

  // Reset / pre-fill the form when the modal opens.
  useEffect(() => {
    if (!open) return
    /* eslint-disable react-hooks/set-state-in-effect -- intentional (pre)fill on `open` prop transition; the extra render is desired */
    if (editOverride) {
      setFormData({
        service_id: editOverride.service_id,
        extra_allocations: String(editOverride.extra_allocations),
        reason: editOverride.reason,
      })
      setExistingRowId(editOverride.id)
    } else {
      setFormData({ service_id: '', extra_allocations: '', reason: '' })
      setExistingRowId(null)
    }
    setErrors({})
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, editOverride])

  // Add flow only: when the chosen service already has an override for the
  // current FY, switch to update-mode and pre-fill it (no duplicate rows).
  const { data: existingForService } = useQuery({
    queryKey: ['allocation-override-existing', propertyId, formData.service_id, effectiveFyId],
    enabled: open && !isEdit && !!formData.service_id && !!effectiveFyId,
    queryFn: async () => {
      const { data } = await supabase
        .from('allocation_override')
        .select('id, extra_allocations, reason')
        .eq('property_id', propertyId)
        .eq('service_id', formData.service_id)
        .eq('fy_id', effectiveFyId as string)
        .maybeSingle()
      return data
    },
  })

  useEffect(() => {
    if (isEdit) return
    /* eslint-disable react-hooks/set-state-in-effect -- keyed on the resolved lookup; pre-fills when an override already exists for the picked service */
    if (existingForService) {
      setExistingRowId(existingForService.id)
      setFormData((prev) => ({
        ...prev,
        extra_allocations: String(existingForService.extra_allocations),
        reason: existingForService.reason,
      }))
    } else {
      setExistingRowId(null)
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [existingForService, isEdit])

  // Validate form
  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!formData.service_id) newErrors.service_id = 'Service is required'
    const n = Number(formData.extra_allocations)
    if (formData.extra_allocations.trim() === '' || !Number.isInteger(n)) {
      newErrors.extra_allocations = 'Enter a whole number'
    } else if (n < -999 || n > 999) {
      newErrors.extra_allocations = 'Must be between -999 and 999'
    }
    if (!formData.reason.trim()) newErrors.reason = 'Reason is required'
    if (!effectiveFyId) newErrors.fy = 'No financial year found'

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  // Save mutation — UPDATE the canonical row when one exists (preserving
  // created_by as the original creator; the audit trigger records the editor),
  // otherwise INSERT a new one.
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!validateForm()) throw new Error('Form validation failed')
      if (!userId) throw new Error('User session not found. Please refresh the page.')
      if (!effectiveFyId) throw new Error('No financial year found.')

      const value = Number(formData.extra_allocations)

      if (existingRowId) {
        const { error } = await supabase
          .from('allocation_override')
          .update({ extra_allocations: value, reason: formData.reason })
          .eq('id', existingRowId)
        if (error) throw error
      } else {
        const { error } = await supabase
          .from('allocation_override')
          .insert({
            property_id: propertyId,
            service_id: formData.service_id,
            fy_id: effectiveFyId,
            extra_allocations: value,
            reason: formData.reason,
            created_by: userId,
          })
        if (error) throw error
      }
    },
    onSuccess: () => {
      onSave()
      onOpenChange(false)
    },
  })

  // Modal-field visual delta over the shared Input base (roomier dialog inputs).
  const modalField = 'rounded-[10px] px-3.5 py-3 text-body placeholder:text-gray-300 focus:border-[var(--brand)]'
  const errorClass = 'mt-1 text-caption text-red-500'

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Popup className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
              <Dialog.Title className="font-[family-name:var(--font-heading)] text-lg font-bold text-[var(--brand)]">
                Adjust Allocation
              </Dialog.Title>
              <Dialog.Close className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </Dialog.Close>
            </div>

            {/* Form */}
            <div className="px-6 py-4">
              <div className="flex flex-col gap-3">
                {/* Property — read-only */}
                <div>
                  <FieldLabel>Property</FieldLabel>
                  <p className="rounded-[10px] border-[1.5px] border-gray-100 bg-gray-100 px-3.5 py-3 text-body text-gray-700">
                    {propertyAddress}
                  </p>
                </div>

                {/* Financial Year — auto-selected */}
                <div>
                  <FieldLabel>Financial Year</FieldLabel>
                  <p className="rounded-[10px] border-[1.5px] border-gray-100 bg-gray-100 px-3.5 py-3 text-body text-gray-700">
                    {effectiveFyLabel}
                  </p>
                  {errors.fy && <p className={errorClass}>{errors.fy}</p>}
                </div>

                {/* Service */}
                <div>
                  <FieldLabel htmlFor="service_id">
                    Service<span className="ml-0.5 text-red-500">*</span>
                  </FieldLabel>
                  <Select
                    id="service_id"
                    value={formData.service_id}
                    onChange={(e) => setFormData({ ...formData, service_id: e.target.value })}
                    disabled={isEdit}
                    className={`${modalField} disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500`}
                  >
                    <option value="">Select a service</option>
                    {services?.map((s) => {
                      const cat = s.category as { name: string; code: string }
                      return (
                        <option key={s.id} value={s.id}>
                          {s.name} ({cat.name})
                        </option>
                      )
                    })}
                  </Select>
                  {errors.service_id && <p className={errorClass}>{errors.service_id}</p>}
                </div>

                {/* Adjustment */}
                <div>
                  <FieldLabel htmlFor="extra_allocations">
                    Adjustment (positive to add, negative to reduce)<span className="ml-0.5 text-red-500">*</span>
                  </FieldLabel>
                  <Input
                    id="extra_allocations"
                    type="number"
                    step="1"
                    value={formData.extra_allocations}
                    onChange={(e) => setFormData({ ...formData, extra_allocations: e.target.value })}
                    placeholder="e.g. 1 or -1"
                    className={modalField}
                  />
                  {errors.extra_allocations && (
                    <p className={errorClass}>{errors.extra_allocations}</p>
                  )}
                  <p className="mt-1 text-caption text-gray-400">
                    Adjusts this service&apos;s allocation for the financial year. A negative value reduces the effective allocation below the base.
                  </p>
                </div>

                {/* Reason */}
                <div>
                  <FieldLabel htmlFor="reason">
                    Reason for Override<span className="ml-0.5 text-red-500">*</span>
                  </FieldLabel>
                  <Textarea
                    id="reason"
                    value={formData.reason}
                    onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                    placeholder="e.g., New owner reinstatement, Council credit, Correction of prior error..."
                    rows={3}
                    className={modalField}
                  />
                  {errors.reason && <p className={errorClass}>{errors.reason}</p>}
                </div>
              </div>
            </div>

            {/* Error banner */}
            {saveMutation.error && (
              <div className="mx-6 mb-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700">
                {saveMutation.error instanceof Error ? saveMutation.error.message : 'An error occurred'}
              </div>
            )}

            {/* Footer */}
            <div className="flex justify-end gap-2 border-t border-gray-100 px-6 py-4">
              <VercoButton
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </VercoButton>
              <VercoButton
                size="sm"
                type="button"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
              >
                {saveMutation.isPending ? 'Saving...' : existingRowId ? 'Update' : 'Create'}
              </VercoButton>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
