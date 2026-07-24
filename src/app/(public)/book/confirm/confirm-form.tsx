'use client'

import { useSearchParams, useRouter } from 'next/navigation'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { invokeEfWithUserToken } from '@/lib/supabase/invoke-ef-client'
import { BookingStepper } from '@/components/booking/booking-stepper'
import { BookingCancelLink } from '@/components/booking/booking-cancel-link'
import { VercoButton } from '@/components/ui/verco-button'
import { decodeItems } from '@/lib/booking/search-params'
import { clientHasTerms } from '@/lib/booking/terms'
import { TermsAcceptanceDialog } from './terms-acceptance-dialog'
import { buildConfirmBreakdown } from '@/lib/pricing/build-breakdown'
import { type ActiveConversion } from '@/lib/pricing/calculate'
import {
  CONVERSION_RULE_SELECT,
  findExistingSwapRuleId,
  flattenConversionRule,
  toActiveConversion,
  type RawConversionRuleRow,
} from '@/lib/pricing/swap'
// replaceBookingAfterEdit import removed — edits now in-place via the EF's
// update branch (no cancel-and-replace dance).
import {
  ContactSchema,
  type ContactFormData,
  formatAuMobileDisplay,
  normaliseAuMobile,
} from '@/lib/booking/schemas'
import { STAFF_ROLES, type StaffRole } from '@/lib/auth/roles'

const OTP_LENGTH = 6
const RESEND_COOLDOWN_SECONDS = 30

export function ConfirmForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const propertyId = searchParams.get('property_id') ?? ''
  const collectionAreaId = searchParams.get('collection_area_id') ?? ''
  const address = searchParams.get('address') ?? ''
  const itemsParam = searchParams.get('items') ?? ''
  const totalCents = parseInt(searchParams.get('total_cents') ?? '0', 10)
  const collectionDateId = searchParams.get('collection_date_id') ?? ''
  const location = searchParams.get('location') ?? ''
  const notes = searchParams.get('notes') ?? ''
  const onBehalf = searchParams.get('on_behalf') === 'true'
  const swap = searchParams.get('swap') === 'true'
  // On-behalf edit flow params — extracted at component scope so the
  // useEffect/useCallback below can depend on the stable values, not the
  // whole searchParams object.
  const replacesParam = searchParams.get('replaces')
  const contactFirstName = searchParams.get('contact_first_name')
  const contactLastName = searchParams.get('contact_last_name')
  const contactEmail = searchParams.get('contact_email')
  const contactMobile = searchParams.get('contact_mobile')

  const selectedItems = decodeItems(itemsParam)
  const supabase = createClient()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [mobileDisplay, setMobileDisplay] = useState('')

  // OTP verification state
  const [otpStep, setOtpStep] = useState(false)
  const [otpEmail, setOtpEmail] = useState('')
  const [otpDigits, setOtpDigits] = useState<string[]>(Array.from({ length: OTP_LENGTH }, () => ''))
  const [otpState, setOtpState] = useState<'idle' | 'verifying' | 'error'>('idle')
  const [otpError, setOtpError] = useState<string | null>(null)
  const [resendCooldown, setResendCooldown] = useState(0)
  const [isResending, setIsResending] = useState(false)
  const otpInputRefs = useRef<(HTMLInputElement | null)[]>([])
  const pendingContactRef = useRef<ContactFormData | null>(null)

  // T&Cs acceptance gate state. termsAcceptedRef is a ref (not state) so the
  // re-invoked onSubmit after acceptance reads the updated value synchronously.
  const [showTerms, setShowTerms] = useState(false)
  const termsAcceptedRef = useRef(false)
  const pendingTermsContactRef = useRef<ContactFormData | null>(null)

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<ContactFormData>({
    resolver: zodResolver(ContactSchema),
  })

  // Pre-fill contact fields from URL params (on-behalf edit) or from profile (resident)
  useEffect(() => {
    if (onBehalf) {
      // On-behalf: prefill from URL params if available (edit flow passes these)
      if (contactFirstName) setValue('first_name', contactFirstName)
      if (contactLastName) setValue('last_name', contactLastName)
      if (contactEmail) setValue('email', contactEmail)
      if (contactMobile) {
        setValue('mobile', contactMobile)
        setMobileDisplay(formatAuMobileDisplay(contactMobile))
      }
      return
    }

    async function prefill() {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) return

      // Defence-in-depth (BR-0015 / VER-251): never prefill a staff member's
      // own contact. Staff always book on-behalf (handled above, which returns
      // early); reaching here as a staff user means a non-on-behalf staff
      // booking — don't leak their contact into resident ownership. Uses the
      // current_user_role() RPC to avoid the .single() multi-role trap (VER-185).
      const { data: role } = await supabase.rpc('current_user_role')
      if (role && STAFF_ROLES.includes(role as StaffRole)) return

      const { data: profile } = await supabase
        .from('profiles')
        .select('contact_id')
        .eq('id', user.id)
        .single()

      if (!profile?.contact_id) return

      const { data: contact } = await supabase
        .from('contacts')
        .select('first_name, last_name, email, mobile_e164')
        .eq('id', profile.contact_id)
        .single()

      if (!contact) return

      if (contact.first_name) setValue('first_name', contact.first_name)
      if (contact.last_name) setValue('last_name', contact.last_name)
      if (contact.email) setValue('email', contact.email)
      if (contact.mobile_e164) {
        setValue('mobile', contact.mobile_e164)
        setMobileDisplay(formatAuMobileDisplay(contact.mobile_e164))
      }
    }

    void prefill()
  }, [supabase, setValue, onBehalf, contactFirstName, contactLastName, contactEmail, contactMobile])

  // Handle mobile input with auto-formatting
  function handleMobileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value
    // Strip to digits and leading +
    const cleaned = raw.replace(/[^\d+]/g, '')

    // Try to normalise and format for display
    const e164 = normaliseAuMobile(cleaned)
    if (e164) {
      setMobileDisplay(formatAuMobileDisplay(e164))
      setValue('mobile', e164, { shouldValidate: false })
    } else {
      // Show raw input while typing, store cleaned for validation
      setMobileDisplay(raw)
      setValue('mobile', cleaned, { shouldValidate: false })
    }
  }

  // Tenant brand + terms, fetched client-side via the public-SELECT `client` table
  // so E2E's PostgREST mock intercepts it (a server fetch would bypass page.route).
  // service_name drives the extra-charges heading; terms_markdown drives the T&Cs gate.
  const { data: clientBrand } = useQuery({
    queryKey: ['client-brand', collectionAreaId],
    enabled: !!collectionAreaId,
    queryFn: async () => {
      const { data } = await supabase
        .from('collection_area')
        .select('client:client_id(service_name, terms_markdown)')
        .eq('id', collectionAreaId)
        .maybeSingle()
      const client = data?.client as unknown as { service_name: string | null; terms_markdown: string | null } | null
      return {
        serviceName: client?.service_name ?? null,
        termsMarkdown: client?.terms_markdown ?? null,
      }
    },
  })
  const serviceName = clientBrand?.serviceName ?? null
  const termsMarkdown = clientBrand?.termsMarkdown ?? null
  // Block submit until the client (and its terms) has loaded, so a fast click
  // can't slip past the gate. The RPC is the fail-closed backstop regardless.
  const clientBrandLoading = !!collectionAreaId && clientBrand === undefined

  // Fetch service details + collection date for display
  const { data: summaryData } = useQuery({
    queryKey: ['booking-summary', itemsParam, collectionDateId, swap, replacesParam],
    enabled: selectedItems.size > 0 && !!collectionDateId,
    queryFn: async () => {
      const serviceIds = Array.from(selectedItems.keys())

      const [servicesResult, dateResult, fyResult, allocationRulesResult] =
        await Promise.all([
          supabase
            .from('service')
            .select('id, name, category!inner(name, code)')
            .in('id', serviceIds),
          supabase
            .from('collection_date')
            .select('date')
            .eq('id', collectionDateId)
            .single(),
          supabase
            .from('financial_year')
            .select('id')
            .eq('is_current', true)
            .single(),
          supabase
            .from('allocation_rules')
            .select('max_collections, category!inner(code)')
            .eq('collection_area_id', collectionAreaId),
        ])

      // Category-level budget maxes (Bulk, Ancillary) for this area
      const categoryMaxMap = new Map<string, number>()
      for (const r of allocationRulesResult.data ?? []) {
        const cat = r.category as unknown as { code: string }
        categoryMaxMap.set(cat.code, r.max_collections)
      }

      // FY usage to determine free vs paid — at BOTH the per-service and the
      // per-category level. The dual-limit engine needs both; the old confirm
      // calc only had per-service, so category-cap-driven paid units silently
      // vanished from the breakdown while the total still charged for them.
      const serviceUsageMap = new Map<string, number>()
      const categoryUsageMap = new Map<string, number>()
      // Conversion-rule id of a swap ALREADY applied to this property this FY
      // (from the RPC's ('swap', <rule_id>, 1) row — the allocation_swap table
      // itself is RLS-scoped and reads empty pre-OTP). The forfeiture lasts the
      // whole FY, so the breakdown must price with it (design §2).
      let existingSwapRuleId: string | null = null
      {
        // FY usage via the authoritative RPC. booking / booking_item are
        // RLS-scoped to the resident, and this confirm page can render pre-OTP
        // (anonymous) — a direct read would return zero and the breakdown would
        // price already-used units as free. get_property_fy_usage is SECURITY
        // DEFINER and returns PII-free counts regardless of auth state. Edit
        // flow excludes the replaced booking so the breakdown re-prices as a
        // replacement (matching the services step + the create-booking EF).
        const { data: usageRows } = await supabase.rpc('get_property_fy_usage', {
          p_property_id: propertyId,
          p_fy_id: fyResult.data?.id ?? undefined,
          p_exclude_booking_id: replacesParam ?? undefined,
        })
        for (const row of usageRows ?? []) {
          if (row.usage_kind === 'service') serviceUsageMap.set(row.usage_key, Number(row.units))
          else if (row.usage_kind === 'category') categoryUsageMap.set(row.usage_key, Number(row.units))
        }
        existingSwapRuleId = findExistingSwapRuleId(usageRows)
      }

      // Service rules (per-service max + extra price)
      const { data: rules } = await supabase
        .from('service_rules')
        .select('service_id, max_collections, extra_unit_price')
        .eq('collection_area_id', collectionAreaId)
        .in('service_id', serviceIds)

      const rulesMap = new Map(
        (rules ?? []).map((r) => [
          r.service_id,
          {
            max_collections: r.max_collections,
            extra_unit_price: r.extra_unit_price,
          },
        ])
      )

      // service_id → name and → category code (from the services fetch)
      type ServiceWithCategory = {
        id: string
        name: string
        category: { name: string; code: string }
      }
      const serviceNames = new Map<string, string>()
      const serviceCategoryMap = new Map<string, string>()
      for (const st of (servicesResult.data ?? []) as unknown as ServiceWithCategory[]) {
        serviceNames.set(st.id, st.name)
        serviceCategoryMap.set(st.id, st.category.code)
      }

      // Active allocation swap — either ticked on THIS booking (load the
      // area's active rule) or already applied earlier this FY (load the rule
      // the swap was recorded under, by id, WITHOUT an is_active filter — the
      // forfeiture stands even if the rule is later deactivated). Either way
      // the breakdown prices with the budgets shifted, matching the EF.
      let conversion: ActiveConversion | undefined
      if (swap || existingSwapRuleId) {
        const query = supabase
          .from('allocation_conversion_rule')
          .select(CONVERSION_RULE_SELECT)
        const { data: ruleData } = existingSwapRuleId
          ? await query.eq('id', existingSwapRuleId)
          : await query
              .eq('is_active', true)
              .eq('from_allocation_rules.collection_area_id', collectionAreaId)
        const raw = (ruleData ?? [])[0] as unknown as RawConversionRuleRow | undefined
        const rule = raw ? flattenConversionRule(raw) : null
        if (rule) conversion = toActiveConversion(rule)
      }

      // Admin allocation top-ups for this property + FY. allocation_override is
      // RLS-scoped to staff, and this page renders as anon/resident, so a direct
      // read returns zero — the granted rollover would be priced as paid extras,
      // disagreeing with the create-booking EF. get_property_allocation_overrides
      // is SECURITY DEFINER and returns PII-free counts regardless of auth state.
      const { data: overrideRows } = await supabase.rpc('get_property_allocation_overrides', {
        p_property_id: propertyId,
        p_fy_id: fyResult.data?.id ?? undefined,
      })
      const overrides = (overrideRows ?? []).map((r) => ({
        service_id: r.service_id,
        extra_allocations: Number(r.extra_allocations),
      }))

      // Price via the shared dual-limit engine — keeps the breakdown in lockstep
      // with the services-step total (both honour the category cap + swap + override).
      const { included, extras } = buildConfirmBreakdown({
        items: Array.from(selectedItems.entries()).map(
          ([service_id, quantity]) => ({ service_id, quantity })
        ),
        serviceNames,
        serviceCategoryMap,
        rulesMap,
        categoryMaxMap,
        serviceUsageMap,
        categoryUsageMap,
        conversion,
        overrides,
      })

      return {
        collectionDate: dateResult.data?.date ?? '',
        included,
        extras,
        swapped: !!conversion,
        // Applied earlier this FY (vs ticked on this booking) — the banner
        // wording differs: nothing about THIS booking includes a free green.
        swappedExisting: !!existingSwapRuleId && !swap,
      }
    },
  })

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return
    const timer = setInterval(() => {
      setResendCooldown((prev) => Math.max(0, prev - 1))
    }, 1000)
    return () => clearInterval(timer)
  }, [resendCooldown])

  // Focus first OTP cell when OTP step shown
  useEffect(() => {
    if (otpStep) {
      otpInputRefs.current[0]?.focus()
    }
  }, [otpStep])

  // Submit the actual booking (called after session is confirmed)
  const submitBooking = useCallback(async (contact: ContactFormData) => {
    setIsSubmitting(true)
    setSubmitError(null)

    try {
      const items = Array.from(selectedItems.entries()).map(
        ([service_id, no_services]) => ({
          service_id,
          no_services,
        })
      )

      // NOTE: kept as raw fetch — does NOT use `invokeEfWithUserToken`.
      // The helper's `fallbackToAnon` rule is "session-OR-anon" (session
      // preferred). This call's rule is the OPPOSITE: "anon for residents,
      // session ONLY when on-behalf=true". Residents reach /book/confirm
      // pre-auth — they MAY have an OTP session by this point but the
      // booking still belongs to them as anonymous, not as the session
      // user. Forcing the session token would attach the booking to whatever
      // contact happens to share that email instead of creating one.
      // See create-booking EF — it branches on auth header to decide.
      const functionUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/create-booking`
      const requestBody = {
        property_id: propertyId,
        collection_area_id: collectionAreaId,
        collection_date_id: collectionDateId,
        location,
        notes: notes || undefined,
        contact: {
          first_name: contact.first_name,
          last_name: contact.last_name,
          email: contact.email,
          mobile_e164: contact.mobile,
        },
        items,
        // Threaded through from the admin "Edit services" wizard launch so
        // both the server-side re-price AND the post-create cleanup
        // (replaceBookingAfterEdit) know which booking is being replaced.
        ...(replacesParam ? { replaces: replacesParam } : {}),
        // Allocation swap — the EF re-validates + records it.
        ...(swap ? { swap: true } : {}),
        // T&Cs acceptance — true once the resident passed the acceptance dialog.
        // The EF/RPC re-read the client's terms server-side and snapshot them.
        terms_accepted: termsAcceptedRef.current,
      }

      // Forward the user's session JWT to create-booking whenever a session
      // exists (not only on-behalf). The EF's auth.getUser() then resolves the
      // acting user, which lets it (a) link a self-booking resident's profile
      // to their contact [F4/VER-248] — without which create-checkout 403s and
      // the dashboard can't find their bookings — and (b) record the real actor
      // in audit_log instead of "System". A pre-auth guest booker has no
      // session, so we correctly fall back to the anon key. The EF only links a
      // profile when the acting user's email matches the contact's, so an
      // on-behalf staff booking (different email) never mis-links.
      let authHeader = `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.access_token) {
        authHeader = `Bearer ${session.access_token}`
      }

      const res = await fetch(functionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify(requestBody),
      })

      if (!res.ok) {
        const errorBody = await res.text()
        console.error('create-booking error:', res.status, errorBody)
        try {
          const parsed = JSON.parse(errorBody)
          setSubmitError(parsed.error ?? `Booking failed (${res.status})`)
        } catch {
          setSubmitError(`Booking failed (${res.status})`)
        }
        setIsSubmitting(false)
        return
      }

      const result = (await res.json()) as {
        booking_id: string
        ref: string
        requires_payment: boolean
      }

      // Admin "Edit services" flow: the EF now updates the existing booking
      // in place when `replaces` is sent (same booking_id, same ref, audit
      // captures the diff). Nothing to clean up client-side — the old
      // replaceBookingAfterEdit cancel-and-replace pattern was retired in
      // favour of the update_booking_items_in_place RPC.

      // Admin on-behalf → admin detail page; resident → public detail page
      const bookingPath = onBehalf
        ? `/admin/bookings/${result.booking_id}`
        : `/booking/${result.ref}`

      if (result.requires_payment) {
        const origin = window.location.origin
        const checkoutResult = await invokeEfWithUserToken<{ checkout_url?: string; already_paid?: boolean }>(
          supabase,
          'create-checkout',
          {
            booking_id: result.booking_id,
            success_url: `${origin}${bookingPath}?success=true`,
            cancel_url: `${origin}${bookingPath}?cancelled=true`,
          },
          { fallbackToAnon: true }
        )

        if (!checkoutResult.ok) {
          console.error('create-checkout error:', checkoutResult.error)
          setSubmitError('Failed to create payment session')
          setIsSubmitting(false)
          return
        }
        // Paid during a webhook gap — create-checkout reconciled the booking
        // to Confirmed instead of minting a new session (VER-252).
        if (checkoutResult.data.already_paid) {
          router.push(`${bookingPath}?success=true`)
          return
        }
        if (!checkoutResult.data.checkout_url) {
          setSubmitError('Failed to create payment session')
          setIsSubmitting(false)
          return
        }

        window.location.href = checkoutResult.data.checkout_url
      } else {
        router.push(`${bookingPath}?success=true`)
      }
    } catch {
      setSubmitError('An unexpected error occurred. Please try again.')
      setIsSubmitting(false)
    }
  }, [selectedItems, propertyId, collectionAreaId, collectionDateId, location, notes, router, onBehalf, replacesParam, swap, supabase])

  // OTP verification after code entry
  const verifyOtp = useCallback(async (code: string) => {
    setOtpState('verifying')
    setOtpError(null)

    const { error } = await supabase.auth.verifyOtp({
      email: otpEmail,
      token: code,
      type: 'email',
    })

    if (error) {
      setOtpState('error')
      setOtpError('Invalid code. Please try again or request a new one.')
      return
    }

    // Verification successful — proceed with booking
    setOtpStep(false)
    if (pendingContactRef.current) {
      void submitBooking(pendingContactRef.current)
    }
  }, [otpEmail, supabase.auth, submitBooking])

  function handleOtpDigitChange(index: number, value: string) {
    const digit = value.replace(/\D/g, '').slice(-1)
    const next = [...otpDigits]
    next[index] = digit
    setOtpDigits(next)

    if (otpState === 'error') {
      setOtpState('idle')
      setOtpError(null)
    }

    if (digit && index < OTP_LENGTH - 1) {
      otpInputRefs.current[index + 1]?.focus()
    }

    if (digit && index === OTP_LENGTH - 1) {
      const code = next.join('')
      if (code.length === OTP_LENGTH) {
        void verifyOtp(code)
      }
    }
  }

  function handleOtpKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !otpDigits[index] && index > 0) {
      otpInputRefs.current[index - 1]?.focus()
      const next = [...otpDigits]
      next[index - 1] = ''
      setOtpDigits(next)
    }
  }

  function handleOtpPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH)
    if (!pasted) return

    const next = Array.from({ length: OTP_LENGTH }, (_, i) => pasted[i] ?? '')
    setOtpDigits(next)

    if (otpState === 'error') {
      setOtpState('idle')
      setOtpError(null)
    }

    const lastFilledIndex = Math.min(pasted.length, OTP_LENGTH) - 1
    otpInputRefs.current[lastFilledIndex]?.focus()

    if (pasted.length === OTP_LENGTH) {
      void verifyOtp(pasted)
    }
  }

  async function handleOtpResend() {
    if (resendCooldown > 0 || isResending) return
    setIsResending(true)

    const { error } = await supabase.auth.signInWithOtp({
      email: otpEmail,
      options: { shouldCreateUser: true },
    })

    setIsResending(false)
    if (!error) {
      setResendCooldown(RESEND_COOLDOWN_SECONDS)
      setOtpDigits(Array.from({ length: OTP_LENGTH }, () => ''))
      setOtpState('idle')
      setOtpError(null)
      otpInputRefs.current[0]?.focus()
    } else {
      setOtpError('Failed to resend code. Please try again.')
    }
  }

  function getOtpCellClassName(index: number): string {
    const base =
      'flex h-[60px] min-w-0 flex-1 basis-[52px] max-w-[52px] items-center justify-center rounded-[10px] border-[1.5px] text-center font-[family-name:var(--font-heading)] text-2xl font-bold outline-none transition-colors'

    if (otpState === 'error') {
      return `${base} border-red-500 bg-red-50 text-red-500`
    }
    if (otpDigits[index]) {
      return `${base} border-[var(--brand)] bg-white text-[var(--brand)]`
    }
    return `${base} border-gray-100 bg-gray-50 text-[var(--brand)] focus:border-[var(--brand)] focus:border-2 focus:bg-white`
  }

  // Form submit handler — checks session, triggers OTP if guest
  async function onSubmit(contact: ContactFormData) {
    setSubmitError(null)

    // T&Cs gate — must accept before the booking is created (and before the
    // confirmation is sent). Intercept BEFORE the session branch so authenticated
    // residents AND guests both pass through it. Empty terms ⇒ skipped. On accept
    // the dialog re-invokes onSubmit with termsAcceptedRef already true.
    if (clientHasTerms(termsMarkdown) && !termsAcceptedRef.current) {
      pendingTermsContactRef.current = contact
      setShowTerms(true)
      return
    }

    // Check if user already has a session
    const { data: { session } } = await supabase.auth.getSession()

    if (session) {
      // Already authenticated — submit directly
      void submitBooking(contact)
      return
    }

    // Guest user — trigger OTP verification
    pendingContactRef.current = contact
    setOtpEmail(contact.email)
    setIsSubmitting(true)

    const { error } = await supabase.auth.signInWithOtp({
      email: contact.email,
      options: { shouldCreateUser: true },
    })

    if (error) {
      setSubmitError('Failed to send verification code. Please try again.')
      setIsSubmitting(false)
      return
    }

    setIsSubmitting(false)
    setResendCooldown(RESEND_COOLDOWN_SECONDS)
    setOtpStep(true)
  }

  function handleBack() {
    const contactFirstName = searchParams.get('contact_first_name')
    const contactLastName = searchParams.get('contact_last_name')
    const contactEmail = searchParams.get('contact_email')
    const contactMobile = searchParams.get('contact_mobile')
    const returnUrl = searchParams.get('return_url')
    const params = new URLSearchParams({
      property_id: propertyId,
      collection_area_id: collectionAreaId,
      address,
      items: itemsParam,
      total_cents: totalCents.toString(),
      collection_date_id: collectionDateId,
      location,
      ...(notes ? { notes } : {}),
      ...(onBehalf ? { on_behalf: 'true' } : {}),
      ...(contactFirstName ? { contact_first_name: contactFirstName } : {}),
      ...(contactLastName ? { contact_last_name: contactLastName } : {}),
      ...(contactEmail ? { contact_email: contactEmail } : {}),
      ...(contactMobile ? { contact_mobile: contactMobile } : {}),
      ...(returnUrl ? { return_url: returnUrl } : {}),
      // Carry the edit signal back — without it, Confirm → Back → Next re-enters
      // the wizard as a NEW booking and creates a duplicate instead of editing.
      ...(replacesParam ? { replaces: replacesParam } : {}),
      // Carry the allocation swap back — without it, Confirm → Back → Next
      // silently unticks the swap and re-prices the swapped unit as paid.
      ...(swap ? { swap: 'true' } : {}),
    })
    router.push(`/book/details?${params.toString()}`)
  }

  const collectionDateFormatted = summaryData?.collectionDate
    ? format(
        new Date(summaryData.collectionDate + 'T00:00:00'),
        'EEEE, d MMMM yyyy'
      )
    : ''

  return (
    <div className="flex flex-col">
      <BookingStepper currentStep={5} />

      {/* Content */}
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto pb-24 pt-6">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-title font-bold leading-tight text-[var(--brand)]">
            Confirm your booking
          </h1>
          <p className="mt-1 text-body-sm leading-relaxed text-gray-500">
            Review your booking details and provide contact information.
          </p>
        </div>

        {/* Contact Information */}
        <form
          id="confirm-form"
          // eslint-disable-next-line react-hooks/refs -- react-hook-form's handleSubmit reads refs at invocation time, not during render
          onSubmit={handleSubmit(onSubmit)}
          // On-behalf bookings start with blank contact fields; suppress browser
          // autofill so a staff member's saved credentials don't silently
          // populate the resident's details (BR-0015 / VER-251).
          autoComplete={onBehalf ? 'off' : 'on'}
          className="rounded-xl bg-white p-6 shadow-sm"
        >
          <h2 className="mb-3.5 font-[family-name:var(--font-heading)] text-body font-semibold text-[var(--brand)]">
            Contact information
          </h2>
          {onBehalf && (
            <div className="mb-3.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-body-sm text-amber-800">
              <strong>Booking on behalf of a resident.</strong> Enter the
              resident&rsquo;s contact details below — not your own.
            </div>
          )}
          <div className="flex flex-col gap-2.5">
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">
                  First name<span className="ml-0.5 text-red-500">*</span>
                </label>
                <input
                  type="text"
                  autoComplete={onBehalf ? 'off' : 'given-name'}
                  placeholder="First name"
                  {...register('first_name')}
                  className="w-full rounded-[10px] border-[1.5px] border-gray-100 bg-gray-50 px-3.5 py-3 text-sm text-gray-900 outline-none placeholder:text-gray-300 focus:border-[var(--brand)] focus:bg-white"
                />
                {errors.first_name && (
                  <p className="mt-1 text-caption text-red-500">
                    {errors.first_name.message}
                  </p>
                )}
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">
                  Last name<span className="ml-0.5 text-red-500">*</span>
                </label>
                <input
                  type="text"
                  autoComplete={onBehalf ? 'off' : 'family-name'}
                  placeholder="Last name"
                  {...register('last_name')}
                  className="w-full rounded-[10px] border-[1.5px] border-gray-100 bg-gray-50 px-3.5 py-3 text-sm text-gray-900 outline-none placeholder:text-gray-300 focus:border-[var(--brand)] focus:bg-white"
                />
                {errors.last_name && (
                  <p className="mt-1 text-caption text-red-500">
                    {errors.last_name.message}
                  </p>
                )}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">
                Email<span className="ml-0.5 text-red-500">*</span>
              </label>
              <input
                type="email"
                autoComplete={onBehalf ? 'off' : 'email'}
                placeholder="Email address"
                {...register('email')}
                className="w-full rounded-[10px] border-[1.5px] border-gray-100 bg-gray-50 px-3.5 py-3 text-sm text-gray-900 outline-none placeholder:text-gray-300 focus:border-[var(--brand)] focus:bg-white"
              />
              {errors.email && (
                <p className="mt-1 text-caption text-red-500">
                  {errors.email.message}
                </p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">
                Mobile<span className="ml-0.5 text-red-500">*</span>
              </label>
              <input
                type="tel"
                autoComplete={onBehalf ? 'off' : 'tel'}
                placeholder="Mobile number (e.g. 0412 345 678)"
                value={mobileDisplay}
                onChange={handleMobileChange}
                className="w-full rounded-[10px] border-[1.5px] border-gray-100 bg-gray-50 px-3.5 py-3 text-sm text-gray-900 outline-none placeholder:text-gray-300 focus:border-[var(--brand)] focus:bg-white"
              />
              {/* Hidden field for react-hook-form */}
              <input type="hidden" {...register('mobile')} />
              {errors.mobile && (
                <p className="mt-1 text-caption text-red-500">
                  {errors.mobile.message}
                </p>
              )}
            </div>
          </div>
        </form>

        {/* Booking summary */}
        <div className="rounded-xl bg-white p-6 shadow-sm">
          <h2 className="mb-3.5 font-[family-name:var(--font-heading)] text-body font-semibold text-[var(--brand)]">
            Booking summary
          </h2>
          <div className="flex flex-col">
            <div className="flex border-b border-gray-100 py-3">
              <span className="w-[90px] shrink-0 text-xs font-medium text-gray-500">
                Address
              </span>
              <span className="text-body-sm text-gray-900">{address}</span>
            </div>
            <div className="flex border-b border-gray-100 py-3">
              <span className="w-[90px] shrink-0 text-xs font-medium text-gray-500">
                Date
              </span>
              <span className="text-body-sm text-gray-900">
                {collectionDateFormatted}
              </span>
            </div>
            <div className="flex py-3">
              <span className="w-[90px] shrink-0 text-xs font-medium text-gray-500">
                Location
              </span>
              <span className="text-body-sm text-gray-900">{location}</span>
            </div>
          </div>
        </div>

        {/* Services breakdown */}
        {summaryData && (
          <div className="rounded-xl bg-white p-6 shadow-sm">
            <h2 className="mb-3.5 font-[family-name:var(--font-heading)] text-body font-semibold text-[var(--brand)]">
              Services
            </h2>

            {summaryData.swapped && (
              <div className="mb-3 rounded-lg border border-[var(--brand-accent-dark)] bg-[#F0FBF5] px-3.5 py-2.5 text-body-sm text-[#2f5320]">
                <strong className="text-[var(--brand)]">Ancillary allocation swapped</strong>{' '}
                {summaryData.swappedExisting
                  ? '— your ancillary collections were swapped for an extra green waste collection earlier this financial year.'
                  : '— your extra green waste collection is included free.'}
              </div>
            )}

            {/* Column header — service split out from quantity, plus amount */}
            <div className="flex items-center border-b border-gray-100 pb-1.5 text-2xs font-medium uppercase tracking-wide text-gray-500">
              <span className="flex-1">Service</span>
              <span className="w-12 text-center">Qty</span>
              <span className="w-20 text-right">Amount</span>
            </div>

            {summaryData.included.length > 0 && (
              <>
                <div className="mb-1 mt-2 text-2xs font-medium uppercase tracking-wide text-gray-400">
                  Included in allocation
                </div>
                {summaryData.included.map((item) => (
                  <div
                    key={item.name}
                    className="flex items-center py-1.5 text-body-sm"
                  >
                    <span className="flex-1 text-gray-900">{item.name}</span>
                    <span className="w-12 text-center text-gray-900">
                      {item.qty}
                    </span>
                    <span className="w-20 text-right text-[#006A38]">
                      &mdash;
                    </span>
                  </div>
                ))}
              </>
            )}

            {summaryData.extras.length > 0 && (
              <>
                <div className="mb-1 mt-2 text-2xs font-medium uppercase tracking-wide text-gray-400">
                  {serviceName ? `${serviceName} Extra` : 'Extra services'}
                </div>
                {summaryData.extras.map((item) => (
                  <div
                    key={item.name}
                    className="flex items-center py-1.5 text-body-sm"
                  >
                    <span className="flex-1 text-gray-900">
                      {item.name}
                      <span className="text-gray-400">
                        {' '}
                        @ ${item.unitPrice.toFixed(2)}
                      </span>
                    </span>
                    <span className="w-12 text-center text-gray-900">
                      {item.qty}
                    </span>
                    <span className="w-20 text-right font-semibold text-[var(--brand)]">
                      ${item.lineTotal.toFixed(2)}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* Total block */}
        <div className="flex items-center justify-between rounded-xl bg-[var(--brand)] px-5 py-4">
          <span
            className="font-[family-name:var(--font-heading)] text-base font-semibold"
            style={{ color: '#FFFFFF' }}
          >
            Total
          </span>
          <span
            data-testid="booking-total"
            className="font-[family-name:var(--font-heading)] text-2xl font-bold text-[var(--brand-accent)]"
          >
            {totalCents > 0
              ? `$${(totalCents / 100).toFixed(2)}`
              : 'No Charge'}
          </span>
        </div>

        {totalCents > 0 && (
          <p className="text-center text-caption text-gray-500">
            Payment will be collected via Stripe before your booking is
            confirmed.
          </p>
        )}

        {submitError && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700">
            {submitError}
          </div>
        )}

        {/* Inline OTP verification */}
        {otpStep && (
          <div className="flex flex-col gap-4 rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
            <div>
              <h2 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[var(--brand)]">
                Verify email to confirm booking
              </h2>
              <p className="mt-1.5 text-body-sm leading-relaxed text-gray-500">
                We sent a 6-digit code to
                <br />
                <strong className="text-[var(--brand)]">{otpEmail}</strong>
              </p>
            </div>

            {/* OTP cells */}
            <div className="flex flex-col gap-3">
              <div className="flex justify-center gap-2">
                {otpDigits.map((digit, i) => (
                  <input
                    key={i}
                    ref={(el) => { otpInputRefs.current[i] = el }}
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={1}
                    value={digit}
                    disabled={otpState === 'verifying'}
                    onChange={(e) => handleOtpDigitChange(i, e.target.value)}
                    onKeyDown={(e) => handleOtpKeyDown(i, e)}
                    onPaste={i === 0 ? handleOtpPaste : undefined}
                    className={getOtpCellClassName(i)}
                  />
                ))}
              </div>

              {otpState === 'error' && otpError && (
                <p role="alert" className="flex items-center justify-center gap-1 text-caption text-red-500">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  {otpError}
                </p>
              )}

              {otpState !== 'error' && (
                <p className="text-center text-body-sm text-gray-500">
                  Enter the 6-digit code from your email
                </p>
              )}
            </div>

            {/* Verify button */}
            <VercoButton
              className="w-full"
              disabled={otpState === 'verifying' || otpDigits.join('').length < OTP_LENGTH}
              onClick={() => {
                const code = otpDigits.join('')
                if (code.length === OTP_LENGTH) void verifyOtp(code)
              }}
            >
              {otpState === 'verifying' ? 'Verifying...' : otpState === 'error' ? 'Try Again' : 'Verify Code'}
            </VercoButton>

            {/* Resend */}
            <div className="text-center text-body-sm text-gray-500">
              {resendCooldown > 0 ? (
                <>
                  Code expires in{' '}
                  <strong className="text-[var(--brand)]">
                    {Math.floor(resendCooldown / 60)}:{(resendCooldown % 60).toString().padStart(2, '0')}
                  </strong>
                  {' · '}
                  <span className="text-gray-300">Resend code</span>
                </>
              ) : (
                <button
                  type="button"
                  onClick={handleOtpResend}
                  disabled={isResending}
                  className="font-semibold text-[var(--brand-accent-dark)] hover:underline disabled:text-gray-300"
                >
                  {isResending ? 'Sending...' : 'Request a new code'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom nav */}
      {!otpStep && (
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
            type="submit"
            form="confirm-form"
            variant={totalCents > 0 ? 'accent' : 'primary'}
            className="flex-1"
            disabled={isSubmitting || clientBrandLoading}
          >
            {isSubmitting
              ? 'Sending code...'
              : totalCents > 0
                ? 'Proceed to payment'
                : 'Confirm booking'}
          </VercoButton>
        </div>
      )}

      {termsMarkdown && (
        <TermsAcceptanceDialog
          open={showTerms}
          termsMarkdown={termsMarkdown}
          onCancel={() => setShowTerms(false)}
          onAccept={() => {
            termsAcceptedRef.current = true
            setShowTerms(false)
            const c = pendingTermsContactRef.current
            if (c) void onSubmit(c)
          }}
        />
      )}
    </div>
  )
}
