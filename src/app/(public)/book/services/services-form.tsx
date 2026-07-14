'use client'

import { useSearchParams, useRouter } from 'next/navigation'
import { useState, useMemo, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { BookingStepper } from '@/components/booking/booking-stepper'
import { BookingCancelLink } from '@/components/booking/booking-cancel-link'
import { VercoButton } from '@/components/ui/verco-button'
import { Spinner } from '@/components/ui/spinner'
import { encodeItems, decodeItems } from '@/lib/booking/search-params'
import type { BookingItem } from '@/lib/booking/schemas'
import { computeLineItems, type ServiceRule } from '@/lib/pricing/calculate'
import {
  isSwapEligible,
  toActiveConversion,
  flattenConversionRule,
  CONVERSION_RULE_SELECT,
  type ConversionRuleRow,
  type RawConversionRuleRow,
} from '@/lib/pricing/swap'

interface ServiceRuleRow {
  id: string
  service_id: string
  max_collections: number
  extra_unit_price: number
  collection_area_id: string
  service: {
    id: string
    name: string
    category_id: string
    category: {
      id: string
      name: string
      code: string
    }
  }
}

export function ServicesForm({ clientSlug }: { clientSlug: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const propertyId = searchParams.get('property_id') ?? ''
  const collectionAreaId = searchParams.get('collection_area_id') ?? ''
  const address = searchParams.get('address') ?? ''
  const onBehalf = searchParams.get('on_behalf') === 'true'

  const supabase = createClient()

  // Prefill from ?items= param (edit flow) or start empty
  const initialItems = searchParams.get('items') ?? ''
  const [quantities, setQuantities] = useState<Map<string, number>>(() => decodeItems(initialItems))

  // Allocation swap (e.g. 3 Ancillary -> 1 Green). Synced from the URL so it
  // survives back/forward through the wizard (same-path soft-nav remount gotcha).
  const [swapApplied, setSwapApplied] = useState(searchParams.get('swap') === 'true')
  useEffect(() => {
    setSwapApplied(searchParams.get('swap') === 'true')
  }, [searchParams])

  // Fetch service rules for this collection area
  const { data: serviceRules, isLoading: serviceRulesLoading } = useQuery({
    queryKey: ['service-rules', collectionAreaId],
    enabled: !!collectionAreaId,
    queryFn: async () => {
      const { data } = await supabase
        .from('service_rules')
        .select(
          '*, service!inner(id, name, category_id, category!inner(id, name, code))'
        )
        .eq('collection_area_id', collectionAreaId)

      return (data ?? []) as unknown as ServiceRuleRow[]
    },
  })

  // Fetch allocation_rules at category level (Bulk max, Ancillary max)
  const { data: categoryAllocations, isLoading: categoryAllocationsLoading } = useQuery({
    queryKey: ['category-allocations', collectionAreaId],
    enabled: !!collectionAreaId,
    queryFn: async () => {
      const { data } = await supabase
        .from('allocation_rules')
        .select('max_collections, category!inner(code)')
        .eq('collection_area_id', collectionAreaId)

      const result = new Map<string, number>()
      if (data) {
        for (const rule of data) {
          const cat = rule.category as unknown as { code: string }
          result.set(cat.code, rule.max_collections)
        }
      }
      return result
    },
  })

  // When in admin "Edit services" mode the wizard has `replaces=<old_id>` —
  // exclude that booking's items from the FY-usage counts so the new
  // selection is priced as a replacement, not an addition.
  const replacesBookingId = searchParams.get('replaces')

  // Existing FY usage (per-category + per-service) via the authoritative RPC.
  // booking / booking_item are RLS-scoped to the resident, but this step runs
  // BEFORE OTP (the resident is anonymous), so a direct read returns zero and
  // the "X of Y remaining" badges + price preview would show full availability
  // even after prior bookings. get_property_fy_usage is SECURITY DEFINER and
  // returns PII-free counts, so it works regardless of auth state. p_fy_id is
  // omitted → the RPC resolves the current FY.
  const { data: fyUsage, isLoading: fyUsageLoading } = useQuery({
    queryKey: ['fy-usage', propertyId, replacesBookingId],
    enabled: !!propertyId,
    queryFn: async () => {
      const { data } = await supabase.rpc('get_property_fy_usage', {
        p_property_id: propertyId,
        p_exclude_booking_id: replacesBookingId ?? undefined,
      })
      const byCategory = new Map<string, number>()
      const byService = new Map<string, number>()
      for (const row of data ?? []) {
        if (row.usage_kind === 'category') byCategory.set(row.usage_key, Number(row.units))
        else if (row.usage_kind === 'service') byService.set(row.usage_key, Number(row.units))
      }
      return { byCategory, byService }
    },
  })

  const fyUsageByCategory = fyUsage?.byCategory
  const fyUsageByService = fyUsage?.byService

  // Admin allocation top-ups (allocation_override) for this property + current FY.
  // Same RLS blind-spot as FY usage: the services step runs pre-OTP (anon) and
  // allocation_override's SELECT policy is staff-only, so a direct read returns
  // zero — a granted rollover would show "0 remaining" and price as paid.
  // get_property_allocation_overrides is SECURITY DEFINER + PII-free (p_fy_id
  // omitted → current FY).
  const { data: overrides, isLoading: overridesLoading } = useQuery({
    queryKey: ['allocation-overrides', propertyId],
    enabled: !!propertyId,
    queryFn: async () => {
      const { data } = await supabase.rpc('get_property_allocation_overrides', {
        p_property_id: propertyId,
      })
      return (data ?? []).map((r) => ({
        service_id: r.service_id,
        extra_allocations: Number(r.extra_allocations),
      }))
    },
  })

  // Roll the per-service overrides up to category buckets for the badge maths
  // (the "X of Y remaining" pill is category-level; computeLineItems does the
  // same rollup internally for the free/paid split).
  const categoryExtraByCode = useMemo(() => {
    const m = new Map<string, number>()
    if (overrides && serviceRules) {
      const catOf = new Map(serviceRules.map((r) => [r.service_id, r.service.category.code]))
      for (const o of overrides) {
        const code = catOf.get(o.service_id)
        if (code) m.set(code, (m.get(code) ?? 0) + o.extra_allocations)
      }
    }
    return m
  }, [overrides, serviceRules])

  // Active allocation conversion rule for this area (e.g. 3 Ancillary -> 1 Green).
  // null when the area has no swap configured.
  const { data: conversionRule } = useQuery({
    queryKey: ['conversion-rule', collectionAreaId],
    enabled: !!collectionAreaId,
    queryFn: async (): Promise<ConversionRuleRow | null> => {
      const { data } = await supabase
        .from('allocation_conversion_rule')
        .select(CONVERSION_RULE_SELECT)
        .eq('is_active', true)
        .eq('from_allocation_rules.collection_area_id', collectionAreaId)
      const raw = (data ?? [])[0] as unknown as RawConversionRuleRow | undefined
      return raw ? flattenConversionRule(raw) : null
    },
  })

  // Whether this property already applied a swap this FY (one per property/FY).
  const { data: hasExistingSwap } = useQuery({
    queryKey: ['existing-swap', propertyId],
    enabled: !!propertyId,
    queryFn: async (): Promise<boolean> => {
      const { data: fy } = await supabase
        .from('financial_year')
        .select('id')
        .eq('is_current', true)
        .single()
      if (!fy) return false
      const { count } = await supabase
        .from('allocation_swap')
        .select('id', { count: 'exact', head: true })
        .eq('property_id', propertyId)
        .eq('fy_id', fy.id)
      return (count ?? 0) > 0
    },
  })

  // Show loading state if any critical query is loading
  const isLoadingData = serviceRulesLoading || categoryAllocationsLoading || fyUsageLoading || overridesLoading

  // Group services by category code
  const grouped = useMemo(() => {
    if (!serviceRules) return { bulk: [], anc: [] }

    const bulk: ServiceRuleRow[] = []
    const anc: ServiceRuleRow[] = []

    for (const rule of serviceRules) {
      const code = rule.service.category.code
      if (code === 'bulk') bulk.push(rule)
      else if (code === 'anc') anc.push(rule)
    }

    return { bulk, anc }
  }, [serviceRules])

  // Build pricing items AND category budget consumption in a single pass.
  // The categoryFreeUsed map tracks how many FREE units each category bucket
  // has consumed — this is used for both pricing AND badge display.
  const { pricingItems, categoryFreeUsed } = useMemo(() => {
    if (!serviceRules || !fyUsageByService || !categoryAllocations || !fyUsageByCategory) {
      return { pricingItems: [] as BookingItem[], categoryFreeUsed: new Map<string, number>() }
    }

    const activeRules = serviceRules.filter(
      (rule) => (quantities.get(rule.service_id) ?? 0) > 0
    )
    const ruleByService = new Map(serviceRules.map((r) => [r.service_id, r]))
    const rulesMap = new Map<string, ServiceRule>(
      serviceRules.map((r) => [
        r.service_id,
        { max_collections: r.max_collections, extra_unit_price: r.extra_unit_price },
      ])
    )
    const serviceCategoryMap = new Map<string, string>(
      serviceRules.map((r) => [r.service_id, r.service.category.code])
    )
    const conversion = swapApplied && conversionRule ? toActiveConversion(conversionRule) : undefined

    // Single source of pricing truth — the same engine the EF + confirm page use
    // (the inline copy this replaced is the bug class fixed in PR #147).
    const priced = computeLineItems(
      activeRules.map((r) => ({ service_id: r.service_id, quantity: quantities.get(r.service_id) ?? 0 })),
      rulesMap,
      categoryAllocations,
      serviceCategoryMap,
      fyUsageByService,
      fyUsageByCategory,
      overrides,
      1,
      conversion,
    )

    const items: BookingItem[] = priced.line_items.map((li) => {
      const rule = ruleByService.get(li.service_id)!
      return {
        service_id: li.service_id,
        service_name: rule.service.name,
        category_name: rule.service.category.name,
        code: li.category_code as 'bulk' | 'anc' | 'id',
        no_services: li.quantity,
        free_units: li.free_units,
        paid_units: li.paid_units,
        unit_price_cents: li.unit_price_cents,
        line_charge_cents: li.line_charge_cents,
      }
    })

    // Free units consumed per category bucket — drives the "X of Y remaining" badges.
    const formUsed = new Map<string, number>()
    for (const li of priced.line_items) {
      formUsed.set(li.category_code, (formUsed.get(li.category_code) ?? 0) + li.free_units)
    }

    return { pricingItems: items, categoryFreeUsed: formUsed }
  }, [serviceRules, fyUsageByService, fyUsageByCategory, categoryAllocations, quantities, swapApplied, conversionRule, overrides])

  // Effective category max, accounting for an applied swap (e.g. the from
  // category loses from_units, the to category gains to_units).
  function effectiveCategoryMax(categoryCode: string): number {
    const base = categoryAllocations?.get(categoryCode) ?? 0
    const extra = categoryExtraByCode.get(categoryCode) ?? 0
    // Mirror computeLineItems: swap-adjust the base (with its clamp) first, THEN
    // add the additive override extra — order matters when from_units > base.
    let swapAdjusted = base
    if (swapApplied && conversionRule) {
      if (categoryCode === conversionRule.from_category_code) {
        swapAdjusted = Math.max(0, base - conversionRule.from_units)
      } else if (categoryCode === conversionRule.to_category_code) {
        swapAdjusted = base + conversionRule.to_units
      }
    }
    return swapAdjusted + extra
  }

  // Badge remaining: effective_max - fyUsed - freeUnitsConsumedByForm
  function getLiveRemaining(categoryCode: string): number {
    const max = effectiveCategoryMax(categoryCode)
    const fyUsed = fyUsageByCategory?.get(categoryCode) ?? 0
    const formFreeUsed = categoryFreeUsed.get(categoryCode) ?? 0
    return Math.max(0, max - fyUsed - formFreeUsed)
  }

  // Swap eligibility (e.g. 3 Ancillary -> 1 Green). The "from" category is the
  // one the resident forfeits.
  const fromCat = conversionRule?.from_category_code
  const ancillaryInCart = useMemo(() => {
    if (!serviceRules || !fromCat) return 0
    return serviceRules
      .filter((r) => r.service.category.code === fromCat)
      .reduce((n, r) => n + (quantities.get(r.service_id) ?? 0), 0)
  }, [serviceRules, quantities, fromCat])

  const swapEligible = isSwapEligible({
    hasRule: !!conversionRule,
    ancillaryFyUsed: fromCat ? (fyUsageByCategory?.get(fromCat) ?? 0) : 0,
    hasExistingSwap: hasExistingSwap ?? false,
    ancillaryInCart,
  })

  function toggleSwap(checked: boolean) {
    setSwapApplied(checked)
    // Forfeit the from-category: ticking the swap clears any of those items
    // from the cart (you can't book ancillary and swap it away at once).
    if (checked && serviceRules && fromCat) {
      setQuantities((prev) => {
        const next = new Map(prev)
        serviceRules
          .filter((r) => r.service.category.code === fromCat)
          .forEach((r) => next.delete(r.service_id))
        return next
      })
    }
  }

  const totalChargeCents = pricingItems.reduce(
    (sum, item) => sum + item.line_charge_cents,
    0
  )

  const totalItems = pricingItems.reduce(
    (sum, item) => sum + item.no_services,
    0
  )

  function updateQty(serviceId: string, delta: number) {
    setQuantities((prev) => {
      const next = new Map(prev)
      const current = next.get(serviceId) ?? 0
      const updated = Math.max(0, current + delta)
      if (updated === 0) {
        next.delete(serviceId)
      } else {
        next.set(serviceId, updated)
      }
      return next
    })
  }

  // Carry forward params from later steps (edit flow) + return_url
  const collectionDateId = searchParams.get('collection_date_id')
  const locationParam = searchParams.get('location')
  const notesParam = searchParams.get('notes')
  const contactFirstName = searchParams.get('contact_first_name')
  const contactLastName = searchParams.get('contact_last_name')
  const contactEmail = searchParams.get('contact_email')
  const contactMobile = searchParams.get('contact_mobile')
  const returnUrl = searchParams.get('return_url')
  const replaces = searchParams.get('replaces')
  const carryParams = {
    ...(collectionDateId ? { collection_date_id: collectionDateId } : {}),
    ...(locationParam ? { location: locationParam } : {}),
    ...(notesParam ? { notes: notesParam } : {}),
    ...(contactFirstName ? { contact_first_name: contactFirstName } : {}),
    ...(contactLastName ? { contact_last_name: contactLastName } : {}),
    ...(contactEmail ? { contact_email: contactEmail } : {}),
    ...(contactMobile ? { contact_mobile: contactMobile } : {}),
    ...(returnUrl ? { return_url: returnUrl } : {}),
    ...(replaces ? { replaces } : {}),
  }

  function handleContinue() {
    if (totalItems === 0) return
    const params = new URLSearchParams({
      property_id: propertyId,
      collection_area_id: collectionAreaId,
      address,
      items: encodeItems(pricingItems),
      total_cents: totalChargeCents.toString(),
      ...(onBehalf ? { on_behalf: 'true' } : {}),
      ...(swapApplied ? { swap: 'true' } : {}),
      ...carryParams,
    })
    router.push(`/book/date?${params.toString()}`)
  }

  function handleBack() {
    const params = new URLSearchParams({
      address,
      ...(initialItems ? { items: initialItems } : {}),
      ...(onBehalf ? { on_behalf: 'true' } : {}),
      ...carryParams,
    })
    router.push(`/book?${params.toString()}`)
  }

  function renderServiceSection(
    title: string,
    categoryCode: string,
    rules: ServiceRuleRow[],
    disabled = false
  ) {
    const max = effectiveCategoryMax(categoryCode)
    const remaining = getLiveRemaining(categoryCode)
    const badgeClass =
      remaining > 0
        ? 'bg-[var(--brand-accent-light)] text-[#006A38]'
        : 'bg-[#FFF0F0] text-[#E53E3E]'
    const accentBg =
      categoryCode === 'bulk' ? 'bg-[var(--brand-accent-dark)]' : 'bg-[var(--brand)]'

    // Extra cost rows for this section
    const extraRows = pricingItems.filter(
      (item) =>
        item.paid_units > 0 &&
        rules.some((r) => r.service_id === item.service_id)
    )

    return (
      <div>
        <div className="mb-2.5 flex items-center justify-between">
          <span className="font-[family-name:var(--font-heading)] text-body font-semibold text-[var(--brand)]">
            {title}
          </span>
          <span
            className={`rounded-full px-2.5 py-1 text-caption font-medium ${badgeClass}`}
          >
            {remaining} of {max} remaining
          </span>
        </div>
        <div className="flex flex-col gap-2">
          {rules.map((rule) => {
            const qty = quantities.get(rule.service_id) ?? 0
            return (
              <div
                key={rule.id}
                className="flex items-center justify-between rounded-xl border-[1.5px] border-gray-100 bg-white px-4 py-3.5 shadow-sm"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`h-10 w-1 rounded-sm ${accentBg}`}
                  />
                  <div className="flex flex-col gap-0.5">
                    <span className="text-body font-semibold text-gray-900">
                      {rule.service.name}
                    </span>
                    <span className="text-xs text-gray-500">
                      {rule.service.category.name}
                    </span>
                  </div>
                </div>
                <div className={`flex items-center gap-2.5 rounded-full bg-gray-50 px-2.5 py-1 ${disabled ? 'opacity-40' : ''}`}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => updateQty(rule.service_id, -1)}
                    className="flex size-7 items-center justify-center rounded-full text-lg font-semibold text-gray-700 disabled:cursor-not-allowed"
                  >
                    &minus;
                  </button>
                  <span className="min-w-[16px] text-center text-body font-semibold text-[var(--brand)]">
                    {qty}
                  </span>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => updateQty(rule.service_id, 1)}
                    className="flex size-7 items-center justify-center rounded-full bg-[var(--brand)] text-lg font-semibold text-[var(--brand-foreground)] disabled:cursor-not-allowed"
                  >
                    +
                  </button>
                </div>
              </div>
            )
          })}

          {/* Extra cost rows */}
          {extraRows.map((item) => (
            <div
              key={`extra-${item.service_id}`}
              className="flex items-center justify-between rounded-lg border border-[var(--brand-accent-dark)] bg-[#F0FBF5] px-3.5 py-2.5 text-body-sm"
            >
              <div className="flex items-center gap-2 text-gray-700">
                <span className="font-semibold text-[var(--brand-accent-dark)]">$</span>
                {item.paid_units} extra {item.service_name.toLowerCase()} @
                ${(item.unit_price_cents / 100).toFixed(2)} each
              </div>
              <span className="font-semibold text-[var(--brand)]">
                ${(item.line_charge_cents / 100).toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <BookingStepper currentStep={2} />

      {/* Content */}
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto pb-24 pt-6">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-title font-bold leading-tight text-[var(--brand)]">
            Select services
          </h1>
          <p className="mt-1 text-body-sm leading-relaxed text-gray-500">
            Choose items for collection. You may combine multiple service types.
          </p>
        </div>

        {/* Loading state */}
        {isLoadingData && (
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl bg-white px-4 py-12 shadow-sm">
            <Spinner size="md" />
            <p className="text-sm text-gray-500">Loading service options...</p>
          </div>
        )}

        {/* Services sections — only show when data is loaded */}
        {!isLoadingData && (
          <>
            {grouped.bulk.length > 0 &&
              renderServiceSection(
                clientSlug === 'vergevalet' ? 'Collection' : 'Bulk collection',
                'bulk',
                grouped.bulk
              )}

            {grouped.anc.length > 0 &&
              renderServiceSection('Ancillary collection', 'anc', grouped.anc, swapApplied)}

            {/* Allocation swap — forfeit the ancillary allocation for an extra Green */}
            {(swapEligible || swapApplied) && conversionRule && (
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border-[1.5px] border-[var(--brand-accent-dark)] bg-[#F0FBF5] px-4 py-3.5 shadow-sm">
                <input
                  type="checkbox"
                  checked={swapApplied}
                  onChange={(e) => toggleSwap(e.target.checked)}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--brand-accent-dark)]"
                />
                <span className="text-body-sm text-gray-700">
                  <strong className="text-[var(--brand)]">
                    Swap your {conversionRule.from_units} ancillary collections for{' '}
                    {conversionRule.to_units} extra green waste collection.
                  </strong>{' '}
                  You won&rsquo;t be able to book e-waste, whitegoods or mattresses this financial year.
                </span>
              </label>
            )}
          </>
        )}

        {/* Total bar */}
        {!isLoadingData && totalChargeCents > 0 && (
          <div className="flex items-center justify-between rounded-[10px] bg-[#E8EEF2] px-4 py-3.5">
            <span className="text-sm font-semibold text-[var(--brand)]">
              Total extra services cost
            </span>
            <span className="font-[family-name:var(--font-heading)] text-lg font-bold text-[var(--brand)]">
              ${(totalChargeCents / 100).toFixed(2)}
            </span>
          </div>
        )}
      </div>

      {/* Bottom nav */}
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
          className="flex-1"
          onClick={handleContinue}
          disabled={totalItems === 0 || isLoadingData}
        >
          Next step &rarr;
        </VercoButton>
      </div>
    </div>
  )
}
