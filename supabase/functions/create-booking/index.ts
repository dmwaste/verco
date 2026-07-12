import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import { z } from 'https://esm.sh/zod@3.23.8'
import { calculatePrice, type ActiveConversion } from '../_shared/pricing.ts'
import { isAreaBookableServer } from '../_shared/area-gate-server.ts'
import { type TermsAcceptanceChannel } from '../_shared/terms.ts'
import { classifyCreator, CREATOR_STAFF_ROLES } from '../_shared/classify-creator.ts'
import { evaluateEditGuard, mayKeepClosedHeldDate } from '../_shared/edit-guard.ts'
import { evaluateQuantityEdit } from '../_shared/quantity-edit-decision.ts'
import { mapEditErrorToStatus } from '../_shared/edit-error-mapping.ts'
import { withSentry } from '../_shared/sentry.ts'

/**
 * Fire-and-forget POST to the send-notification Edge Function. Returns
 * nothing — failures are logged to the Supabase console but never thrown
 * back to the caller, so the booking creation always completes.
 */
async function invokeSendNotification(payload: {
  type: 'booking_created'
  booking_id: string
}): Promise<void> {
  try {
    const url = `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1/send-notification`
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)')
      console.error(
        `[notifications] send-notification returned ${res.status} for ${payload.type} ${payload.booking_id}: ${body}`
      )
    }
  } catch (err) {
    console.error(
      `[notifications] Failed to invoke send-notification for ${payload.type} ${payload.booking_id}:`,
      err instanceof Error ? err.message : String(err)
    )
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ── Input validation ─────────────────────────────────────────────────────────

const ContactInput = z.object({
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  email: z.string().email().max(320),
  mobile_e164: z.string().regex(/^\+614\d{8}$/, 'Must be a valid AU mobile in E.164 format'),
})

const BookingItemInput = z.object({
  service_id: z.string().uuid(),
  no_services: z.number().int().min(1).max(10),
})

const CreateBookingRequest = z.object({
  property_id: z.string().uuid(),
  collection_area_id: z.string().uuid(),
  collection_date_id: z.string().uuid(),
  location: z.string().min(1).max(100),
  notes: z.string().max(500).optional(),
  // Optional so the inline quantity editor (replaces + inline_edit) can omit it
  // — the edit branch never touches the contact. The create path guards its
  // presence explicitly (§7). The wizard/resident create path always sends it.
  contact: ContactInput.optional(),
  items: z.array(BookingItemInput).min(1).max(20),
  // Admin "Edit services" flow — exclude the replaced booking from FY-usage
  // count in the server-side re-price. Without this, the new selection
  // appears as "additional" services and gets charged as extras even though
  // the resident is just modifying their existing booking.
  replaces: z.string().uuid().optional(),
  // Allocation swap (e.g. 3 Ancillary -> 1 Green). When true the EF loads the
  // active conversion rule for the area, re-validates eligibility server-side
  // (red line #1 — the client cannot grant itself a swap), and records it.
  swap: z.boolean().optional(),
  // T&Cs acceptance — the resident (or staff on-behalf) affirmed the client's Terms
  // before submit. The RPC re-reads the client's terms and RAISEs if required-but-not-
  // accepted; the accepted text/version are snapshotted server-side (never client-supplied).
  terms_accepted: z.boolean().optional(),
  // Inline admin quantity editor (issue #380). Only the inline editor's server
  // action sets this. It switches the `replaces` edit branch to the delta+drift
  // money model (allow delta<=0 with a refund the CALLER processes; block drift
  // and paid increases). Absent/false ⇒ the shared wizard edit path keeps its
  // strict `total_cents>0` reject unchanged — so this can't introduce a refund
  // leak on the wizard flow, which does not orchestrate refunds. See spec §3/§4.
  inline_edit: z.boolean().optional(),
})

serve(withSentry('create-booking', async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders })
  }

  // Anon-key client for reads (respects RLS public SELECT policies)
  const supabaseAnon = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  )

  // Service-role client for writes (booking, booking_item, contacts inserts)
  // Required because INSERT policies on these tables require auth, but guest
  // bookings are allowed from public routes with only the anon key.
  const supabaseService = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  try {
    // ── 1. Parse + validate input ────────────────────────────────────────────

    const body = await req.json()
    const parsed = CreateBookingRequest.safeParse(body)

    if (!parsed.success) {
      return jsonResponse({ error: parsed.error.message }, 400)
    }

    const { property_id, collection_area_id, collection_date_id, location, notes, contact, items, replaces, swap, terms_accepted, inline_edit } = parsed.data

    // ── 2. Resolve collection area → client_id, contractor_id, area code ─────

    const { data: area, error: areaError } = await supabaseAnon
      .from('collection_area')
      .select('id, client_id, contractor_id, code, is_active')
      .eq('id', collection_area_id)
      .single()

    if (areaError || !area) {
      return jsonResponse({ error: 'Collection area not found' }, 404)
    }

    // Staged go-live gate (WS-A / VER-269): early, friendly rejection for
    // held-back councils. The durable enforcement is the capacity RPC + the
    // booking_resident_insert RLS policy (both fail closed); this keeps the
    // resident path's 403 fast and specific. Shared seam: isAreaBookableServer.
    if (!isAreaBookableServer(area)) {
      return jsonResponse(
        { error: 'This collection area is not currently open for online bookings' },
        403
      )
    }

    // ── 3. Verify property belongs to this collection area ───────────────────

    const { data: property, error: propError } = await supabaseAnon
      .from('eligible_properties')
      .select('id, collection_area_id, is_mud, unit_count')
      .eq('id', property_id)
      .single()

    if (propError || !property) {
      return jsonResponse({ error: 'Property not found' }, 404)
    }

    if (property.collection_area_id !== collection_area_id) {
      return jsonResponse({ error: 'Property does not belong to this collection area' }, 400)
    }

    // ── 4. Look up current financial year ────────────────────────────────────

    const { data: fy, error: fyError } = await supabaseAnon
      .from('financial_year')
      .select('id')
      .eq('is_current', true)
      .single()

    if (fyError || !fy) {
      return jsonResponse({ error: 'No active financial year found' }, 500)
    }

    // ── 5. Verify collection date exists and is open ─────────────────────────

    const { data: collDate, error: collDateError } = await supabaseAnon
      .from('collection_date')
      .select('id, is_open, collection_area_id')
      .eq('id', collection_date_id)
      .single()

    if (collDateError || !collDate) {
      return jsonResponse({ error: 'Collection date not found' }, 404)
    }

    // collection_date is public-SELECT, so the id alone proves nothing about
    // tenancy — pin the date to the requested area or a crafted request could
    // land items on (and mutate the capacity counters of) another area's or
    // another tenant's date.
    if (collDate.collection_area_id !== collection_area_id) {
      return jsonResponse({ error: 'Collection date does not belong to this collection area' }, 400)
    }

    if (!collDate.is_open) {
      // #378: a contractor-tier actor editing a booking may KEEP that booking's
      // own held date after it has been admin-closed — a retained date, not a new
      // booking on a closed slot. Waive the guard only for that exact case
      // (contractor role + the target IS the replaced booking's held date). The
      // reads run through the caller's RLS-scoped client, so ownership + role are
      // enforced server-side; residents/client-tier never qualify.
      let keepsClosedHeldDate = false
      if (replaces) {
        const [{ data: keepRole }, { data: replacedBooking }] = await Promise.all([
          supabaseAnon.rpc('current_user_role'),
          supabaseAnon
            .from('booking')
            .select('booking_item(collection_date_id)')
            .eq('id', replaces)
            .maybeSingle(),
        ])
        const heldDateIds =
          ((replacedBooking?.booking_item ?? []) as Array<{ collection_date_id: string }>)
            .map((bi) => bi.collection_date_id)
        keepsClosedHeldDate = mayKeepClosedHeldDate({
          role: (keepRole as string | null) ?? null,
          replaces,
          targetDateId: collection_date_id,
          heldDateIds,
        })
      }

      if (!keepsClosedHeldDate) {
        return jsonResponse({ error: 'Collection date is no longer open for bookings' }, 400)
      }
    }

    // ── 5b. Resolve + re-validate an allocation swap (if requested) ──────────
    // The swap (e.g. 3 Ancillary -> 1 Green) is config-driven by
    // allocation_conversion_rule. Re-validated here so the client can't grant
    // itself a swap (red line #1). Residential only — swaps are not offered for
    // MUDs, and calculatePrice ignores the conversion when unitMultiplier != 1.
    let conversion: ActiveConversion | undefined
    let swapRuleId: string | undefined
    if (swap) {
      const { data: ruleRows, error: ruleErr } = await supabaseAnon
        .from('allocation_conversion_rule')
        .select(
          'id, from_units, to_units, to_service_id, ' +
          'from_allocation_rules:from_allocation_rules_id!inner ( collection_area_id, category:category_id ( code ) ), ' +
          'to_allocation_rules:to_allocation_rules_id ( category:category_id ( code ) )'
        )
        .eq('is_active', true)
        .eq('from_allocation_rules.collection_area_id', collection_area_id)
      if (ruleErr) {
        return jsonResponse({ error: `Failed to load swap rule: ${ruleErr.message}` }, 500)
      }
      const rule = (ruleRows ?? [])[0] as {
        id: string
        from_units: number
        to_units: number
        to_service_id: string
        from_allocation_rules: { collection_area_id: string; category: { code: string } | null } | null
        to_allocation_rules: { category: { code: string } | null } | null
      } | undefined
      if (!rule?.from_allocation_rules?.category || !rule?.to_allocation_rules?.category) {
        return jsonResponse({ error: 'No allocation swap is available for this area.' }, 400)
      }
      const fromCode = rule.from_allocation_rules.category.code

      // Eligibility A: the cart must not contain any item from the swapped-away category.
      const { data: cartCats } = await supabaseAnon
        .from('service')
        .select('id, category:category_id!inner ( code )')
        .in('id', items.map((i) => i.service_id))
      const cartHasFrom = (cartCats ?? []).some(
        (s: { category: { code: string } | null }) => s.category?.code === fromCode
      )
      if (cartHasFrom) {
        return jsonResponse({ error: 'You cannot book that category and swap it away in the same booking.' }, 400)
      }

      // Eligibility B: 0 of the swapped-away category used this FY (excl. the
      // edited booking). Via the authoritative RPC — a direct read runs in the
      // caller's RLS scope, so a pre-OTP resident could be wrongly granted the
      // swap on the basis of prior ancillary usage their own scope hides.
      const { data: swapUsage } = await supabaseAnon.rpc('get_property_fy_usage', {
        p_property_id: property_id,
        p_fy_id: fy.id,
        p_exclude_booking_id: replaces ?? null,
      })
      const fromUsed = Number(
        (swapUsage ?? []).find(
          (r: { usage_kind: string; usage_key: string }) =>
            r.usage_kind === 'category' && r.usage_key === fromCode,
        )?.units ?? 0,
      )
      if (fromUsed > 0) {
        return jsonResponse({
          error: 'The allocation swap is only available before any ancillary collection is used this year.',
        }, 400)
      }

      conversion = {
        from_category_code: fromCode,
        to_category_code: rule.to_allocation_rules.category.code,
        to_service_id: rule.to_service_id,
        from_units: rule.from_units,
        to_units: rule.to_units,
      }
      swapRuleId = rule.id
    }

    // ── 6. Re-run pricing engine server-side (NEVER trust client prices) ─────

    // MUD properties: allocations scale by unit count
    const unitMultiplier = property.is_mud && property.unit_count > 0 ? property.unit_count : 1

    const pricingItems = items.map((i) => ({
      service_id: i.service_id,
      quantity: i.no_services,
    }))

    const priceResult = await calculatePrice(
      supabaseAnon,
      property_id,
      collection_area_id,
      fy.id,
      pricingItems,
      replaces,
      unitMultiplier,
      conversion,
    )

    // Pre-step: actingUser is needed by both branches (edit + create).
    const { data: { user: actingUserEarly } } = await supabaseAnon.auth.getUser()

    // ── 6a. Edit-in-place branch ─────────────────────────────────────────────
    // When `replaces` is set the caller is editing an existing booking. We
    // update items atomically (capacity refunded + re-allocated under one
    // advisory lock) preserving the booking row, same ref, same audit lineage
    // — instead of cancelling + creating a new booking. Contact + status
    // aren't changed via this path.
    //
    // Restriction: in-place edit only supports total_cents = 0 (free-quota
    // changes). Edits that introduce paid items would need new Stripe
    // checkout + partial refund of the old, which is out of scope for v1.
    // Such edits should be handled via cancel + rebook.
    if (replaces) {
      // ── Ownership + cutoff guard (IDOR + late-edit hardening) ──────────────
      // The smart-diff RPC below runs on the SERVICE-ROLE client (RLS bypassed)
      // with a client-supplied booking id. Prove access FIRST by reading the
      // replaced booking through the caller's RLS-scoped anon client: a guest
      // guessing a UUID, or a staffer outside their client scope, gets no row.
      // Then block residents editing past the cancellation cutoff (staff exempt).
      const [{ data: ownedBooking }, { data: callerRole }] = await Promise.all([
        supabaseAnon
          .from('booking')
          .select('id, status, booking_item(service_id, no_services, collection_date!inner(date))')
          .eq('id', replaces)
          .maybeSingle(),
        supabaseAnon.rpc('current_user_role'),
      ])

      const currentCollectionDate =
        ((ownedBooking?.booking_item ?? []) as Array<{ collection_date: { date: string } | null }>)
          .map((bi) => bi.collection_date?.date)
          .filter((d): d is string => !!d)
          .sort()[0] ?? null

      const guard = evaluateEditGuard({
        bookingExists: !!ownedBooking,
        currentCollectionDate,
        role: (callerRole as string | null) ?? null,
        now: new Date(),
      })
      if (!guard.ok) {
        return jsonResponse({ error: guard.error }, guard.status)
      }

      // Delta + drift money model — gated on inline_edit so the shared wizard
      // edit path keeps its strict guard (spec §3 v2 / §4). `refundOwedCents`
      // is returned to the caller (the inline server action), which processes
      // the refund via the existing refund_request + process-refund machinery.
      //
      // inline_edit is STAFF + Confirmed-only, enforced HERE because this EF is
      // the trust boundary, not the admin action: evaluateEditGuard admits
      // residents (their wizard edit path), so without these gates a resident
      // could hand-craft inline_edit=true and reduce their own PAID booking with
      // the owed refund returned to a caller that never orchestrates it — and
      // any staff tier could reduce a Scheduled/Completed booking, refunding a
      // dispatched or already-collected service and desyncing its stops.
      if (inline_edit) {
        if (!callerRole || !(CREATOR_STAFF_ROLES as readonly string[]).includes(callerRole as string)) {
          return jsonResponse({ error: 'Inline quantity edits are staff-only.' }, 403)
        }
        if (ownedBooking?.status !== 'Confirmed') {
          return jsonResponse({
            error: `Cannot edit quantities for a booking with status "${ownedBooking?.status}". Cancel and rebook.`,
          }, 409)
        }
      }
      let refundOwedCents = 0
      // The item set the inline refund is priced against — passed to the RPC as
      // p_expected_items so it can abort under its lock if a concurrent edit
      // changed the items since this baseline was read (#387.1). Null on the
      // wizard path (no refund, no precondition).
      let expectedItems: Array<{ service_id: string; no_services: number }> | null = null
      if (inline_edit) {
        // Baseline: re-price the booking's CURRENT items with the SAME engine
        // call/state as new_total (exclude self, same swap/unitMultiplier), so
        // other bookings' usage cancels in the delta (drift-immune marginal cost).
        const currentItemsMap = new Map<string, number>()
        for (const bi of (ownedBooking?.booking_item ?? []) as Array<{ service_id: string; no_services: number }>) {
          currentItemsMap.set(bi.service_id, (currentItemsMap.get(bi.service_id) ?? 0) + bi.no_services)
        }
        expectedItems = Array.from(currentItemsMap.entries()).map(([service_id, no_services]) => ({
          service_id,
          no_services,
        }))
        const baselineResult = await calculatePrice(
          supabaseAnon,
          property_id,
          collection_area_id,
          fy.id,
          Array.from(currentItemsMap.entries()).map(([service_id, quantity]) => ({ service_id, quantity })),
          replaces,
          unitMultiplier,
          conversion,
        )
        // Collected = amount actually still held = SUM(paid booking_payment)
        // MINUS SUM(approved refund_request). process-refund only flips the
        // refund_request to 'Approved'; it never lowers booking_payment. Netting
        // approved refunds here is what lets a SECOND inline reduction succeed —
        // otherwise `collected` stays at the original charge, the re-priced
        // baseline (now lower) no longer matches it, and the drift guard would
        // wrongly block every edit after the first refund (BR review flag #4).
        // A failed refund stays 'Pending' (uncounted) → collected stays high →
        // the booking correctly reads as drifted until staff resolve it.
        // Ownership was proven above via the anon read, so a service-role SUM
        // here is safe (no PII, avoids an RLS surprise on these tables).
        const [{ data: paidPayments }, { data: approvedRefunds }] = await Promise.all([
          supabaseService
            .from('booking_payment')
            .select('amount_cents')
            .eq('booking_id', replaces)
            .eq('status', 'paid'),
          supabaseService
            .from('refund_request')
            .select('amount_cents')
            .eq('booking_id', replaces)
            .eq('status', 'Approved'),
        ])
        const paidCents = (paidPayments ?? []).reduce(
          (sum: number, p: { amount_cents: number }) => sum + p.amount_cents,
          0,
        )
        const refundedCents = (approvedRefunds ?? []).reduce(
          (sum: number, r: { amount_cents: number }) => sum + r.amount_cents,
          0,
        )
        const collectedCents = paidCents - refundedCents
        const decision = evaluateQuantityEdit({
          baselineTotalCents: baselineResult.total_cents,
          newTotalCents: priceResult.total_cents,
          collectedCents,
        })
        if (decision.kind === 'block_drift') {
          return jsonResponse({
            error: "This booking's pricing has changed since it was booked. Cancel and rebook to adjust it.",
            code: 'price_drift',
          }, 409)
        }
        if (decision.kind === 'block_requires_payment') {
          return jsonResponse({
            error: 'Increasing the quantity adds a paid extra. Cancel and rebook to add paid services.',
            code: 'requires_payment',
          }, 409)
        }
        refundOwedCents = decision.refundOwedCents
      } else if (priceResult.total_cents > 0) {
        return jsonResponse({
          error: 'In-place edit cannot introduce new paid services. Cancel and rebook to change paid items.',
        }, 400)
      }

      const editItems: Array<{
        service_id: string
        no_services: number
        unit_price_cents: number
        is_extra: boolean
        category_code: string
      }> = []
      for (const li of priceResult.line_items) {
        if (li.free_units > 0) {
          editItems.push({
            service_id: li.service_id,
            no_services: li.free_units,
            unit_price_cents: 0,
            is_extra: false,
            category_code: li.category_code,
          })
        }
        // paid_units is 0 on the wizard path (strict guard) but CAN be > 0 on
        // the inline_edit path (a paid→smaller-paid reduction still leaves paid
        // units). Emit paid rows either way so the RPC's smart-diff updates them.
        if (li.paid_units > 0) {
          editItems.push({
            service_id: li.service_id,
            no_services: li.paid_units,
            unit_price_cents: li.unit_price_cents,
            is_extra: true,
            category_code: li.category_code,
          })
        }
      }

      const { data: editResult, error: editError } = await supabaseService
        .rpc('update_booking_items_in_place', {
          p_booking_id: replaces,
          p_collection_date_id: collection_date_id,
          p_items: editItems,
          p_actor_id: actingUserEarly?.id ?? null,
          // Inline quantity edits never change location/notes — pass null so
          // the RPC keeps the current values (re-sending the caller's copy
          // would silently revert a concurrent location edit). Wizard path
          // still updates both.
          p_location: inline_edit ? null : location,
          p_notes: inline_edit ? null : (notes ?? null),
          // Concurrency guard (#387.1): only the inline refund path sends the
          // baseline it priced against; the RPC aborts if the items changed
          // under its lock. Wizard path sends null → guard skipped.
          ...(expectedItems ? { p_expected_items: expectedItems } : {}),
        })

      if (editError) {
        console.error('Edit RPC error:', editError)
        const editMessage = editError.message ?? ''
        // Capacity shortfall keeps its own 409 — it predates the concurrent-edit
        // taxonomy and is not an "edit error → status" case, so it is matched
        // before mapEditErrorToStatus runs.
        if (editMessage.includes('Insufficient')) {
          return jsonResponse({ error: editMessage }, 409)
        }
        // not found → 404; the #387.1 concurrent-edit marker → 409
        // concurrent_edit (retryable — admin reloads and re-prices); else → 500.
        const { status, code } = mapEditErrorToStatus(editMessage)
        const error = status === 500 ? `Failed to update booking: ${editMessage}` : editMessage
        return jsonResponse({ error, ...(code ? { code } : {}) }, status)
      }

      const edited = editResult as { booking_id: string; ref: string }

      // Reconcile the allocation swap on edit: ensure exactly one swap row iff
      // this edit is still a swap. Editing the swap away removes the forfeiture
      // (restores the resident's ancillary allocation).
      if (swap && swapRuleId) {
        const { error: swapUpsertErr } = await supabaseService
          .from('allocation_swap')
          .upsert({
            property_id,
            fy_id: fy.id,
            collection_area_id,
            allocation_conversion_rule_id: swapRuleId,
            booking_id: edited.booking_id,
          }, { onConflict: 'property_id,fy_id' })
        if (swapUpsertErr) console.error('allocation_swap upsert (edit) error:', swapUpsertErr)
      } else {
        const { error: swapDelErr } = await supabaseService
          .from('allocation_swap')
          .delete()
          .eq('booking_id', edited.booking_id)
        if (swapDelErr) console.error('allocation_swap delete (edit) error:', swapDelErr)
      }

      return jsonResponse({
        booking_id: edited.booking_id,
        ref: edited.ref,
        requires_payment: false,
        edited: true,
        // Inline quantity editor: how much the caller must refund via the
        // existing refund machinery (0 on the wizard path). Emitted on every
        // path so the parser never has to default it (EF contract, CLAUDE.md §11).
        refund_owed_cents: refundOwedCents,
      })
    }

    // ── 7. Upsert contact (by email) ────────────────────────────────────────

    // Contact is optional in the schema (the inline edit branch above never uses
    // it and returns before here). The create path requires it.
    if (!contact) {
      return jsonResponse({ error: 'Contact is required to create a booking' }, 400)
    }

    const { data: existingContact } = await supabaseService
      .from('contacts')
      .select('id')
      .eq('email', contact.email)
      .maybeSingle()

    let contactId: string

    if (existingContact) {
      // Update name and mobile if they've changed.
      // full_name is a generated column — must write first/last_name.
      const { error: updateError } = await supabaseService
        .from('contacts')
        .update({
          first_name: contact.first_name,
          last_name: contact.last_name,
          mobile_e164: contact.mobile_e164,
        })
        .eq('id', existingContact.id)

      if (updateError) {
        console.error('Contact update error:', updateError)
        return jsonResponse({ error: 'Failed to update contact' }, 500)
      }

      contactId = existingContact.id
    } else {
      const { data: newContact, error: insertError } = await supabaseService
        .from('contacts')
        .insert({
          first_name: contact.first_name,
          last_name: contact.last_name,
          email: contact.email,
          mobile_e164: contact.mobile_e164,
        })
        .select('id')
        .single()

      if (insertError || !newContact) {
        console.error('Contact insert error:', insertError)
        return jsonResponse({ error: 'Failed to create contact' }, 500)
      }

      contactId = newContact.id
    }

    // ── 7b. Link acting user's profile → contact (resident self-bookings only) ─
    //
    // When a resident completes the guest-OTP flow, the auth user + profile are
    // created seconds before this EF runs, so `profile.contact_id` is NULL. The
    // resident RLS policy on `contacts` requires `current_user_contact_id() =
    // id` — which returns NULL until this link exists. Without server-side
    // linking, the resident's dashboard cannot find their own contact, the
    // booking is invisible to them, and the client-side linking step in
    // confirm-form.tsx (which depends on the same contacts SELECT) cannot
    // recover.
    //
    // Guard: only link when the acting user's email matches the contact's
    // email. This skips staff on-behalf bookings (different emails) and any
    // other case where an authenticated user creates a booking for someone
    // else, avoiding accidental cross-account links.
    //
    // Non-blocking: any error is logged and swallowed — the booking has
    // already succeeded and the user still gets their confirmation. Worst
    // case the dashboard fallback won't find them, which the next booking or
    // a manual backfill will resolve.
    if (
      actingUserEarly?.id
      && actingUserEarly.email
      && actingUserEarly.email.toLowerCase() === contact.email.toLowerCase()
    ) {
      const { error: linkError } = await supabaseService
        .from('profiles')
        .update({ contact_id: contactId })
        .eq('id', actingUserEarly.id)
        .is('contact_id', null)

      if (linkError) {
        console.error(
          '[create-booking] profile-contact link failed (non-fatal):',
          linkError.message,
        )
      }
    }

    // ── 8. Determine initial status ──────────────────────────────────────────
    //
    // Auto-confirm (Option B, 2026-05-18): free bookings land directly in
    // Confirmed — there is no separate staff "Confirm" gate. Paid bookings
    // still start in Pending Payment; the Stripe webhook flips them straight
    // to Confirmed on payment success. The Submitted state is preserved in
    // the enum + state-machine matrix as a safety net for legacy bookings
    // and any future re-introduced manual gate, but no new code path writes
    // it.

    const requiresPayment = priceResult.total_cents > 0
    const initialStatus = requiresPayment ? 'Pending Payment' : 'Confirmed'

    // ── 9. Build items payload for RPC ───────────────────────────────────────
    // Split line items with both free and paid units into separate booking_item
    // rows so the detail page can display "2 Included + 1 Paid" correctly.

    const rpcItems: Array<{
      service_id: string
      no_services: number
      unit_price_cents: number
      is_extra: boolean
      category_code: string
    }> = []

    for (const li of priceResult.line_items) {
      if (li.free_units > 0) {
        rpcItems.push({
          service_id: li.service_id,
          no_services: li.free_units,
          unit_price_cents: 0,
          is_extra: false,
          category_code: li.category_code,
        })
      }
      if (li.paid_units > 0) {
        rpcItems.push({
          service_id: li.service_id,
          no_services: li.paid_units,
          unit_price_cents: li.unit_price_cents,
          is_extra: true,
          category_code: li.category_code,
        })
      }
    }

    // ── 10. Call capacity-safe RPC (advisory lock + insert) ──────────────────
    //
    // Pass acting user as p_actor_id so the audit_log trigger attributes the
    // booking to whoever clicked submit:
    //   - resident on /book/confirm (no auth) → null → audit shows "System"
    //   - staff on /book?on_behalf=true (admin JWT) → user.id → audit shows
    //     the staff member's name once the resolver picks it up
    const actingUser = actingUserEarly

    // Acceptance channel: a staff member booking on-behalf acts under their own
    // JWT but the booking's contact is the RESIDENT (different email) — the same
    // signal used below to gate profile-linking. A guest or a resident's own
    // session (matching email) is resident_self.
    const termsChannel: TermsAcceptanceChannel =
      actingUser?.email && actingUser.email.toLowerCase() !== contact.email.toLowerCase()
        ? 'staff_on_behalf'
        : 'resident_self'

    // CBSTAMP (VER-179 §4.2): stamp the immutable created_via channel for the
    // self-service metric. auth.uid() is NULL inside the service-role RPC, so we
    // resolve the acting user's role HERE (live JWT context) and pass created_via
    // explicitly. Staff role ⇒ admin; else the email match/mismatch decides
    // resident vs admin; guest / no session ⇒ resident.
    let actingUserRole: string | null = null
    if (actingUser?.id) {
      const { data: roleRows } = await supabaseService
        .from('user_roles')
        .select('role')
        .eq('user_id', actingUser.id)
      const roles = (roleRows ?? []).map((r: { role: string }) => r.role)
      actingUserRole =
        roles.find((r: string) => (CREATOR_STAFF_ROLES as readonly string[]).includes(r)) ??
        roles.find((r: string) => r === 'ranger') ??
        roles[0] ??
        null
    }
    const { createdVia } = classifyCreator({
      hasSession: !!actingUser?.id,
      actingUserRole,
      actingUserEmail: actingUser?.email ?? null,
      contactEmail: contact.email,
    })

    const { data: rpcResult, error: rpcError } = await supabaseService
      .rpc('create_booking_with_capacity_check', {
        p_collection_date_id: collection_date_id,
        p_property_id: property_id,
        p_contact_id: contactId,
        p_collection_area_id: collection_area_id,
        p_client_id: area.client_id,
        p_contractor_id: area.contractor_id,
        p_fy_id: fy.id,
        p_area_code: area.code,
        p_location: location,
        p_notes: notes ?? null,
        p_status: initialStatus,
        p_items: rpcItems,
        p_actor_id: actingUser?.id ?? null,
        p_terms_accepted: terms_accepted ?? false,
        p_terms_channel: termsChannel,
        p_created_via: createdVia,
      })

    if (rpcError) {
      console.error('RPC error:', rpcError)

      if (rpcError.message?.includes('Terms and Conditions')) {
        return jsonResponse({ error: 'Please accept the Terms & Conditions to continue.' }, 409)
      }

      if (rpcError.message?.includes('Insufficient')) {
        return jsonResponse({ error: rpcError.message }, 409)
      }

      return jsonResponse({ error: `Failed to create booking: ${rpcError.message}` }, 500)
    }

    const bookingId = rpcResult.booking_id
    const ref = rpcResult.ref

    // ── 10b. Record the allocation swap (forfeits the from-category for the FY) ─
    // The unique(property_id, fy_id) constraint is the concurrency backstop: a
    // second booking that races the eligibility check fails here with 23505.
    if (conversion && swapRuleId) {
      const { error: swapErr } = await supabaseService
        .from('allocation_swap')
        .insert({
          property_id,
          fy_id: fy.id,
          collection_area_id,
          allocation_conversion_rule_id: swapRuleId,
          booking_id: bookingId,
        })
      if (swapErr) {
        if ((swapErr as { code?: string }).code === '23505') {
          return jsonResponse({
            error: 'A swap has already been applied for this property this year.',
          }, 409)
        }
        // Non-unique failure: the booking exists but the forfeiture didn't
        // record. Log loudly; worst case is a recoverable over-grant.
        console.error('allocation_swap insert error (booking already created):', swapErr)
      }
    }

    // ── 11. Fire booking_created notification (free path only) ──────────────
    // Paid bookings land in 'Pending Payment' and get notified via
    // stripe-webhook on the Pending Payment → Submitted transition.
    // Fire-and-forget — failure never breaks the booking creation.
    if (!requiresPayment) {
      void invokeSendNotification({
        type: 'booking_created',
        booking_id: bookingId,
      })
    }

    // ── 12. Return result ────────────────────────────────────────────────────

    return jsonResponse({
      booking_id: bookingId,
      ref,
      requires_payment: requiresPayment,
      total_cents: priceResult.total_cents,
    })
  } catch (err) {
    console.error('create-booking error:', err)
    const message = err instanceof Error ? err.message : String(err)
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
}))
