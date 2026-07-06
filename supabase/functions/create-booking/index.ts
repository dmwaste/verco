import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import { z } from 'https://esm.sh/zod@3.23.8'
import { calculatePrice, type ActiveConversion } from '../_shared/pricing.ts'
import { isAreaBookableServer } from '../_shared/area-gate-server.ts'
import { type TermsAcceptanceChannel } from '../_shared/terms.ts'
import { classifyCreator, CREATOR_STAFF_ROLES } from '../_shared/classify-creator.ts'
import { evaluateEditGuard } from '../_shared/edit-guard.ts'

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
  contact: ContactInput,
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
})

serve(async (req) => {
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

    const { property_id, collection_area_id, collection_date_id, location, notes, contact, items, replaces, swap, terms_accepted } = parsed.data

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
      .select('id, is_open')
      .eq('id', collection_date_id)
      .single()

    if (collDateError || !collDate) {
      return jsonResponse({ error: 'Collection date not found' }, 404)
    }

    if (!collDate.is_open) {
      return jsonResponse({ error: 'Collection date is no longer open for bookings' }, 400)
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

      // Eligibility B: 0 of the swapped-away category used this FY (excl. the edited booking).
      let usageQ = supabaseAnon
        .from('booking_item')
        .select('no_services, service:service_id!inner ( category:category_id!inner ( code ) ), booking:booking_id!inner ( property_id, fy_id, status )')
        .eq('booking.property_id', property_id)
        .eq('booking.fy_id', fy.id)
        .eq('service.category.code', fromCode)
        .not('booking.status', 'in', '("Cancelled","Pending Payment")')
      if (replaces) usageQ = usageQ.neq('booking_id', replaces)
      const { data: fromUsage } = await usageQ
      const fromUsed = (fromUsage ?? []).reduce(
        (n: number, r: { no_services: number }) => n + r.no_services, 0
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
          .select('id, booking_item(collection_date!inner(date))')
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

      if (priceResult.total_cents > 0) {
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
        // paid_units must be 0 here due to the guard above, but keep the
        // shape consistent so future loosening doesn't introduce silent
        // skips of paid rows.
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
          p_location: location,
          p_notes: notes ?? null,
        })

      if (editError) {
        console.error('Edit RPC error:', editError)
        if (editError.message?.includes('Insufficient')) {
          return jsonResponse({ error: editError.message }, 409)
        }
        if (editError.message?.includes('not found')) {
          return jsonResponse({ error: editError.message }, 404)
        }
        return jsonResponse({ error: `Failed to update booking: ${editError.message}` }, 500)
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
      })
    }

    // ── 7. Upsert contact (by email) ────────────────────────────────────────

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
})
