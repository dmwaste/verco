'use client'

import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@base-ui/react/dialog'
import { createClient } from '@/lib/supabase/client'
import { invokeEfWithUserToken } from '@/lib/supabase/invoke-ef-client'
import { normaliseAuMobile, formatAuMobileDisplay } from '@/lib/booking/schemas'
import type { Database } from '@/lib/supabase/types'

type AppRole = Database['public']['Enums']['app_role']

const CONTRACTOR_ROLES: AppRole[] = ['contractor-admin', 'contractor-staff', 'field']
const CLIENT_ROLES: AppRole[] = ['client-admin', 'client-staff', 'ranger']
// Strata is client-scoped (needs client_id in user_roles) but shown separately
const CLIENT_AND_STRATA_ROLES: AppRole[] = [...CLIENT_ROLES, 'strata']

const ROLE_OPTIONS: { value: AppRole; label: string }[] = [
  { value: 'contractor-admin', label: 'Contractor Admin' },
  { value: 'contractor-staff', label: 'Contractor Staff' },
  { value: 'field', label: 'Contractor Field' },
  { value: 'client-admin', label: 'Client Admin' },
  { value: 'client-staff', label: 'Client Staff' },
  { value: 'ranger', label: 'Client Ranger' },
  { value: 'strata', label: 'Strata User' },
]

const UserFormSchema = z
  .object({
    first_name: z.string().min(1, 'First name is required').max(100),
    last_name: z.string().min(1, 'Last name is required').max(100),
    email: z.string().email('Please enter a valid email'),
    mobile_e164: z
      .string()
      .transform((val) => val.replace(/[\s\-()]+/g, ''))
      .refine(
        (val) => val === '' || normaliseAuMobile(val) !== null,
        'Please enter a valid AU mobile (e.g. 0412 345 678)'
      )
      .transform((val) => (val ? normaliseAuMobile(val) ?? '' : ''))
      .optional(),
    role: z.enum([
      'contractor-admin', 'contractor-staff', 'field',
      'client-admin', 'client-staff', 'ranger',
      'resident', 'strata',
    ] as const),
    tenant_id: z.string().uuid().or(z.literal('')).optional(),
    // VER-216 — optional sub-client scope. Empty string means "no scope
    // selected" (full client scope). Only meaningful for client-tier roles.
    sub_client_id: z.string().uuid().or(z.literal('')).optional(),
    // MUD property assignments for strata users. Required when role = strata.
    mud_property_ids: z.string().uuid().array().optional(),
  })
  .superRefine((data, ctx) => {
    if (CONTRACTOR_ROLES.includes(data.role as AppRole) && !data.tenant_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Please select a contractor.',
        path: ['tenant_id'],
      })
    }
    if (CLIENT_AND_STRATA_ROLES.includes(data.role as AppRole) && !data.tenant_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Please select a client.',
        path: ['tenant_id'],
      })
    }
    if (data.role === 'strata' && (!data.mud_property_ids || data.mud_property_ids.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Select at least one MUD property.',
        path: ['mud_property_ids'],
      })
    }
  })

type UserFormData = z.infer<typeof UserFormSchema>

export interface EditUserData {
  user_id: string
  first_name: string
  last_name: string
  email: string
  mobile_e164: string | null
  role: AppRole
  contractor_id: string | null
  client_id: string | null
  /** VER-216 — null means "full client scope" (all sub-clients). */
  sub_client_id: string | null
}

interface UserFormDialogProps {
  callerRole: AppRole
  /** If provided, dialog is in edit mode with pre-filled data */
  editData?: EditUserData | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function UserFormDialog({ callerRole, editData, open, onOpenChange }: UserFormDialogProps) {
  const supabase = createClient()
  const queryClient = useQueryClient()
  const isEdit = !!editData

  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [successEmail, setSuccessEmail] = useState<string | null>(null)

  // Compute initial tenant_id from editData
  function getInitialTenantId(): string {
    if (!editData) return ''
    return editData.contractor_id ?? editData.client_id ?? ''
  }

  // Format mobile for display in form (show local format if E.164)
  function getDisplayMobile(): string {
    if (!editData?.mobile_e164) return ''
    return formatAuMobileDisplay(editData.mobile_e164)
  }

  const {
    register,
    handleSubmit,
    watch,
    reset,
    setValue,
    formState: { errors },
  } = useForm<UserFormData>({
    resolver: zodResolver(UserFormSchema),
    defaultValues: {
      first_name: editData?.first_name ?? '',
      last_name: editData?.last_name ?? '',
      email: editData?.email ?? '',
      mobile_e164: getDisplayMobile(),
      role: editData?.role ?? 'client-staff',
      tenant_id: getInitialTenantId(),
      sub_client_id: editData?.sub_client_id ?? '',
      mud_property_ids: [],
    },
  })

  // Reset form when editData changes (opening for a different user)
  useEffect(() => {
    if (open) {
      reset({
        first_name: editData?.first_name ?? '',
        last_name: editData?.last_name ?? '',
        email: editData?.email ?? '',
        mobile_e164: editData ? getDisplayMobile() : '',
        role: editData?.role ?? 'client-staff',
        tenant_id: editData ? getInitialTenantId() : '',
        sub_client_id: editData?.sub_client_id ?? '',
        mud_property_ids: [],
      })
      setSubmitError(null)
      setSuccessEmail(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editData?.user_id])

  const selectedRole = watch('role') as AppRole
  const selectedTenantId = watch('tenant_id')
  const selectedMudPropertyIds = watch('mud_property_ids') ?? []
  const needsContractor = CONTRACTOR_ROLES.includes(selectedRole)
  const needsClient = CLIENT_ROLES.includes(selectedRole)
  const isStrata = selectedRole === 'strata'
  const needsTenant = needsContractor || needsClient || isStrata

  // client-admin can only create client-tier + strata roles
  const availableRoles = callerRole === 'client-admin'
    ? ROLE_OPTIONS.filter((r) => CLIENT_AND_STRATA_ROLES.includes(r.value))
    : ROLE_OPTIONS

  const { data: contractors } = useQuery({
    queryKey: ['contractors-list'],
    queryFn: async () => {
      const { data } = await supabase
        .from('contractor')
        .select('id, name')
        .eq('is_active', true)
        .order('name')
      return data ?? []
    },
    enabled: needsContractor,
  })

  const { data: clients } = useQuery({
    queryKey: ['clients-list'],
    queryFn: async () => {
      const { data } = await supabase
        .from('client')
        .select('id, name')
        .eq('is_active', true)
        .order('name')
      return data ?? []
    },
    // Shared query: also needed for strata to scope client_id + MUD properties
    enabled: needsClient || isStrata,
  })

  // VER-216 — fetch sub-clients for the currently selected client. Only
  // fired for client-tier roles with a tenant selected. Returns [] for
  // clients with no sub-clients (e.g. kwn) which hides the picker.
  const { data: subClients } = useQuery({
    queryKey: ['sub-clients-list', selectedTenantId],
    queryFn: async () => {
      if (!selectedTenantId) return []
      const { data } = await supabase
        .from('sub_client')
        .select('id, code, name')
        .eq('client_id', selectedTenantId)
        .order('code')
      return data ?? []
    },
    enabled: needsClient && !!selectedTenantId,
  })

  // MUD properties for the selected client — shown for strata role only
  const { data: mudProperties } = useQuery({
    queryKey: ['mud-properties', selectedTenantId],
    queryFn: async () => {
      if (!selectedTenantId) return []
      const { data } = await supabase
        .from('eligible_properties')
        .select('id, address, mud_code, collection_area!inner(client_id)')
        .eq('is_mud', true)
        .eq('is_eligible', true)
        .eq('collection_area.client_id', selectedTenantId)
        .order('address')
      return (data ?? []) as { id: string; address: string; mud_code: string | null }[]
    },
    enabled: isStrata && !!selectedTenantId,
  })

  function toggleMudProperty(id: string) {
    const next = selectedMudPropertyIds.includes(id)
      ? selectedMudPropertyIds.filter((x) => x !== id)
      : [...selectedMudPropertyIds, id]
    setValue('mud_property_ids', next, { shouldValidate: true })
  }

  const showSubClientPicker = needsClient && !!selectedTenantId && (subClients?.length ?? 0) > 0

  function handleClose() {
    onOpenChange(false)
    reset()
    setSubmitError(null)
    setSuccessEmail(null)
  }

  async function onSubmit(data: UserFormData) {
    setIsSubmitting(true)
    setSubmitError(null)

    try {
      const role = data.role as AppRole
      const isContractorRole = CONTRACTOR_ROLES.includes(role)
      const isClientRole = CLIENT_ROLES.includes(role)

      const requestBody: Record<string, unknown> = {
        first_name: data.first_name,
        last_name: data.last_name,
        email: data.email,
        role: data.role,
      }

      if (data.mobile_e164) requestBody.mobile_e164 = data.mobile_e164

      if (isContractorRole && data.tenant_id) {
        requestBody.contractor_id = data.tenant_id
      }
      if (isClientRole && data.tenant_id) {
        requestBody.client_id = data.tenant_id
      }
      // VER-216 — only send sub_client_id when explicitly chosen and the
      // role is client-tier. Empty string = "no scope" = NULL in DB.
      if (isClientRole && data.sub_client_id) {
        requestBody.sub_client_id = data.sub_client_id
      }
      // Strata: send client_id for user_roles scoping + MUD property bindings
      if (role === 'strata' && data.tenant_id) {
        requestBody.client_id = data.tenant_id
        requestBody.mud_property_ids = data.mud_property_ids ?? []
      }

      const efResult = await invokeEfWithUserToken(supabase, 'create-user', requestBody)

      if (!efResult.ok) {
        try {
          const parsed = JSON.parse(efResult.error)
          setSubmitError(parsed.error ?? `Failed to ${isEdit ? 'update' : 'create'} user`)
        } catch {
          setSubmitError(efResult.error)
        }
        setIsSubmitting(false)
        return
      }

      setSuccessEmail(data.email)
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] })
    } catch (err) {
      console.error('User form submit error:', err)
      setSubmitError(
        err instanceof Error
          ? `Error: ${err.message}`
          : 'An unexpected error occurred. Please try again.'
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  const inputClass =
    'w-full rounded-[10px] border-[1.5px] border-gray-100 bg-gray-50 px-3.5 py-3 text-sm text-gray-900 outline-none placeholder:text-gray-300 focus:border-[#293F52] focus:bg-white'
  const labelClass = 'mb-1 block text-xs font-medium text-gray-700'
  const errorClass = 'mt-1 text-[11px] text-red-500'

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Popup className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            {successEmail ? (
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="flex size-12 items-center justify-center rounded-full bg-[#E8FDF0]">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#00B864" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                </div>
                <Dialog.Title className="font-[family-name:var(--font-heading)] text-lg font-bold text-[#293F52]">
                  {isEdit ? 'User Updated' : 'User Created'}
                </Dialog.Title>
                {!isEdit && (
                  <>
                    <p className="text-sm text-gray-500">
                      A confirmation email has been sent to
                    </p>
                    <span className="rounded-lg bg-[#E8EEF2] px-4 py-2 font-[family-name:var(--font-heading)] text-sm font-bold text-[#293F52]">
                      {successEmail}
                    </span>
                  </>
                )}
                <button
                  type="button"
                  onClick={handleClose}
                  className="mt-2 w-full rounded-xl bg-[#293F52] px-3.5 py-3 font-[family-name:var(--font-heading)] text-body font-semibold text-white transition-opacity hover:opacity-90"
                >
                  Done
                </button>
              </div>
            ) : (
              <>
                <div className="mb-5 flex items-center justify-between">
                  <Dialog.Title className="font-[family-name:var(--font-heading)] text-lg font-bold text-[#293F52]">
                    {isEdit ? 'Edit User' : 'Add User'}
                  </Dialog.Title>
                  <Dialog.Close className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </Dialog.Close>
                </div>

                <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
                  {/* Name */}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className={labelClass}>
                        First Name<span className="ml-0.5 text-red-500">*</span>
                      </label>
                      <input type="text" autoComplete="given-name" placeholder="Jane" {...register('first_name')} className={inputClass} />
                      {errors.first_name && <p className={errorClass}>{errors.first_name.message}</p>}
                    </div>
                    <div>
                      <label className={labelClass}>
                        Last Name<span className="ml-0.5 text-red-500">*</span>
                      </label>
                      <input type="text" autoComplete="family-name" placeholder="Smith" {...register('last_name')} className={inputClass} />
                      {errors.last_name && <p className={errorClass}>{errors.last_name.message}</p>}
                    </div>
                  </div>

                  {/* Email */}
                  <div>
                    <label className={labelClass}>
                      Email<span className="ml-0.5 text-red-500">*</span>
                    </label>
                    <input
                      type="email"
                      placeholder="jane@example.com"
                      {...register('email')}
                      className={`${inputClass} ${isEdit ? 'bg-gray-100 text-gray-500' : ''}`}
                      readOnly={isEdit}
                    />
                    {errors.email && <p className={errorClass}>{errors.email.message}</p>}
                    {isEdit && <p className="mt-0.5 text-[11px] text-gray-400">Email cannot be changed</p>}
                  </div>

                  {/* Mobile */}
                  <div>
                    <label className={labelClass}>Mobile</label>
                    <input type="text" placeholder="0412 345 678" {...register('mobile_e164')} className={inputClass} />
                    {errors.mobile_e164 && <p className={errorClass}>{errors.mobile_e164.message}</p>}
                  </div>

                  {/* Role */}
                  <div>
                    <label className={labelClass}>
                      Role<span className="ml-0.5 text-red-500">*</span>
                    </label>
                    <select {...register('role')} className={inputClass}>
                      {availableRoles.map((r) => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </select>
                    {errors.role && <p className={errorClass}>{errors.role.message}</p>}
                  </div>

                  {/* Tenant picker — contractor/client/strata all need a scope */}
                  {needsTenant && (
                    <div>
                      <label className={labelClass}>
                        {needsContractor ? 'Contractor' : 'Client'}
                        <span className="ml-0.5 text-red-500">*</span>
                      </label>
                      <select {...register('tenant_id')} className={inputClass}>
                        <option value="">Select {needsContractor ? 'contractor' : 'client'}...</option>
                        {needsContractor &&
                          (contractors ?? []).map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        {(needsClient || isStrata) &&
                          (clients ?? []).map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                      </select>
                      {errors.tenant_id && <p className={errorClass}>{errors.tenant_id.message}</p>}
                    </div>
                  )}

                  {/* Sub-client — VER-216. Only client-tier roles (not strata) with a
                      tenant selected AND that tenant has at least one sub_client. */}
                  {showSubClientPicker && (
                    <div>
                      <label className={labelClass}>
                        Sub-client (optional)
                      </label>
                      <select {...register('sub_client_id')} className={inputClass}>
                        <option value="">All sub-clients (whole client)</option>
                        {(subClients ?? []).map((sc) => (
                          <option key={sc.id} value={sc.id}>
                            {sc.code} — {sc.name}
                          </option>
                        ))}
                      </select>
                      <p className="mt-0.5 text-[11px] text-gray-400">
                        Restricts this user to bookings, notices and properties under one
                        sub-client. Leave as &ldquo;All sub-clients&rdquo; for client-wide access.
                      </p>
                      {errors.sub_client_id && <p className={errorClass}>{errors.sub_client_id.message}</p>}
                    </div>
                  )}

                  {/* MUD property assignment — strata role only, shown once client is selected */}
                  {isStrata && !!selectedTenantId && (
                    <div>
                      <label className={labelClass}>
                        MUD Properties<span className="ml-0.5 text-red-500">*</span>
                      </label>
                      {(mudProperties?.length ?? 0) === 0 ? (
                        <p className="rounded-[10px] border border-dashed border-gray-200 px-3.5 py-3 text-sm text-gray-400">
                          No MUD properties found for this client.
                        </p>
                      ) : (
                        <div className="max-h-48 overflow-y-auto rounded-[10px] border-[1.5px] border-gray-100 bg-gray-50 divide-y divide-gray-100">
                          {(mudProperties ?? []).map((prop) => (
                            <label
                              key={prop.id}
                              className="flex cursor-pointer items-start gap-3 px-3.5 py-2.5 hover:bg-gray-100"
                            >
                              <input
                                type="checkbox"
                                checked={selectedMudPropertyIds.includes(prop.id)}
                                onChange={() => toggleMudProperty(prop.id)}
                                className="mt-0.5 shrink-0 accent-[#293F52]"
                              />
                              <span className="text-sm text-gray-900">
                                {prop.mud_code && (
                                  <span className="mr-1.5 text-xs font-medium text-gray-500">
                                    {prop.mud_code}
                                  </span>
                                )}
                                {prop.address}
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                      {selectedMudPropertyIds.length > 0 && (
                        <p className="mt-1 text-[11px] text-gray-400">
                          {selectedMudPropertyIds.length} propert{selectedMudPropertyIds.length === 1 ? 'y' : 'ies'} selected
                        </p>
                      )}
                      {errors.mud_property_ids && (
                        <p className={errorClass}>{errors.mud_property_ids.message}</p>
                      )}
                    </div>
                  )}

                  {/* Error banner */}
                  {submitError && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700">
                      {submitError}
                    </div>
                  )}

                  {/* Submit */}
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="mt-1 flex w-full items-center justify-center gap-2 rounded-xl bg-[#293F52] px-3.5 py-3.5 font-[family-name:var(--font-heading)] text-body font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {isSubmitting
                      ? (isEdit ? 'Saving...' : 'Creating...')
                      : (isEdit ? 'Save Changes' : 'Create User')}
                  </button>
                </form>
              </>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
