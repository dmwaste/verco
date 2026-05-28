'use client'

import { useState, useEffect } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Dialog } from '@base-ui/react/dialog'
import { createClient } from '@/lib/supabase/client'
import { VercoButton } from '@/components/ui/verco-button'

interface AllocationFormModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: () => void
  propertyId: string
  propertyAddress: string
}

export function AllocationFormModal({ open, onOpenChange, onSave, propertyId, propertyAddress }: AllocationFormModalProps) {
  const supabase = createClient()
  const [userId, setUserId] = useState<string | null>(null)
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

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional modal-reset on `open` prop transition; the extra render is desired
      setFormData({ service_id: '', extra_allocations: '', reason: '' })
      setErrors({})
    }
  }, [open])

  // Validate form
  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!formData.service_id) newErrors.service_id = 'Service is required'
    if (!formData.extra_allocations) newErrors.extra_allocations = 'Extra allocations is required'
    if (isNaN(Number(formData.extra_allocations)) || Number(formData.extra_allocations) < 1) {
      newErrors.extra_allocations = 'Must be a positive whole number'
    }
    if (!formData.reason.trim()) newErrors.reason = 'Reason is required'
    if (!currentFy) newErrors.fy = 'No current financial year found'

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  // Create mutation
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!validateForm()) throw new Error('Form validation failed')
      if (!userId) throw new Error('User session not found. Please refresh the page.')
      if (!currentFy) throw new Error('No current financial year found.')

      const payload = {
        property_id: propertyId,
        service_id: formData.service_id,
        fy_id: currentFy.id,
        extra_allocations: Number(formData.extra_allocations),
        reason: formData.reason,
        created_by: userId,
      }

      const { error } = await supabase
        .from('allocation_override')
        .insert(payload)

      if (error) throw error
    },
    onSuccess: () => {
      onSave()
      onOpenChange(false)
    },
  })

  const inputClass =
    'w-full rounded-[10px] border-[1.5px] border-gray-100 bg-gray-50 px-3.5 py-3 text-body text-gray-900 outline-none placeholder:text-gray-300 focus:border-[var(--brand)] focus:bg-white'
  const labelClass = 'mb-1 block text-xs font-medium text-gray-700'
  const errorClass = 'mt-1 text-[11px] text-red-500'

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Popup className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
              <Dialog.Title className="font-[family-name:var(--font-heading)] text-lg font-bold text-[var(--brand)]">
                Add Extra Allocations
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
                  <label className={labelClass}>Property</label>
                  <p className="rounded-[10px] border-[1.5px] border-gray-100 bg-gray-100 px-3.5 py-3 text-body text-gray-700">
                    {propertyAddress}
                  </p>
                </div>

                {/* Financial Year — auto-selected */}
                <div>
                  <label className={labelClass}>Financial Year</label>
                  <p className="rounded-[10px] border-[1.5px] border-gray-100 bg-gray-100 px-3.5 py-3 text-body text-gray-700">
                    {currentFy?.label ?? 'Loading...'}
                  </p>
                  {errors.fy && <p className={errorClass}>{errors.fy}</p>}
                </div>

                {/* Service */}
                <div>
                  <label className={labelClass}>
                    Service<span className="ml-0.5 text-red-500">*</span>
                  </label>
                  <select
                    value={formData.service_id}
                    onChange={(e) => setFormData({ ...formData, service_id: e.target.value })}
                    className={inputClass}
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
                  </select>
                  {errors.service_id && <p className={errorClass}>{errors.service_id}</p>}
                </div>

                {/* Extra Allocations */}
                <div>
                  <label className={labelClass}>
                    Extra Allocations<span className="ml-0.5 text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={formData.extra_allocations}
                    onChange={(e) => setFormData({ ...formData, extra_allocations: e.target.value })}
                    placeholder="1"
                    className={inputClass}
                  />
                  {errors.extra_allocations && (
                    <p className={errorClass}>{errors.extra_allocations}</p>
                  )}
                  <p className="mt-1 text-[11px] text-gray-400">
                    How many extra allocations to add for this service?
                  </p>
                </div>

                {/* Reason */}
                <div>
                  <label className={labelClass}>
                    Reason for Override<span className="ml-0.5 text-red-500">*</span>
                  </label>
                  <textarea
                    value={formData.reason}
                    onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                    placeholder="e.g., New owner reinstatement, Council credit, Correction of prior error..."
                    rows={3}
                    className={inputClass}
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
                {saveMutation.isPending ? 'Saving...' : 'Create'}
              </VercoButton>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
