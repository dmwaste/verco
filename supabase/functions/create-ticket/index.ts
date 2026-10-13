import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from '../_shared/database.types.ts'
import { z } from 'https://esm.sh/zod@3.23.8'
import { corsHeaders, jsonResponse, optionsResponse, errorResponse } from '../_shared/cors.ts'
import { attachContact } from '../_shared/contact-attach.ts'

// ── Input validation ─────────────────────────────────────────────────────────

const ContactInput = z.object({
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  email: z.string().email().max(320),
  mobile_e164: z.string().regex(/^\+614\d{8}$/).optional(),
})

const CreateTicketRequest = z.object({
  subject: z.string().min(5).max(150),
  category: z.enum(['general', 'booking', 'billing', 'service', 'complaint', 'other']),
  message: z.string().min(20).max(2000),
  booking_id: z.string().uuid().optional(),
  client_id: z.string().uuid(),
  contact: ContactInput,
})

// ── Display ID generation ────────────────────────────────────────────────────

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

function generateDisplayId(): string {
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += CHARSET[Math.floor(Math.random() * CHARSET.length)]
  }
  return `TKT-${code}`
}

// Roles permitted to call create-ticket. resident/strata create tickets
// on their own behalf (email pinned to their auth email). Staff roles may
// create tickets for arbitrary contact emails (legitimate on-behalf flow).
const ALLOWED_ROLES = [
  'resident',
  'strata',
  'client-admin',
  'client-staff',
  'contractor-admin',
  'contractor-staff',
] as const
type AllowedRole = (typeof ALLOWED_ROLES)[number]

const STAFF_ROLES: readonly AllowedRole[] = [
  'client-admin',
  'client-staff',
  'contractor-admin',
  'contractor-staff',
]

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return optionsResponse()
  }

  // Validate the caller's JWT and gate by role. Presence-only auth checks
  // would let any anon-key holder upsert contacts by email collision and
  // overwrite the contact's PII via the service-role mutation below.

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return errorResponse('Unauthorized', 401)
  }

  const supabaseUser = createClient<Database>(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  )

  const { data: userData, error: userError } = await supabaseUser.auth.getUser()
  if (userError || !userData.user) {
    return errorResponse('Unauthorized', 401)
  }
  const authUser = userData.user

  const { data: roleData, error: roleError } = await supabaseUser.rpc('current_user_role')
  if (roleError) {
    return errorResponse(`Role lookup failed: ${roleError.message}`, 500)
  }
  const role = roleData as AllowedRole | null
  if (!role || !ALLOWED_ROLES.includes(role)) {
    return errorResponse('Forbidden: insufficient role', 403)
  }
  const isStaff = STAFF_ROLES.includes(role)

  // Service-role client for writes (contact upsert + ticket insert).
  // Auth has already gated the caller; service role is used only for the
  // mutations themselves, NOT for identity checks.
  const supabaseService = createClient<Database>(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  try {
    // ── 1. Parse + validate input ──────────────────────────────────────────

    const body = await req.json()
    const parsed = CreateTicketRequest.safeParse(body)

    if (!parsed.success) {
      return errorResponse(parsed.error.message, 400)
    }

    const { subject, category, message, booking_id, client_id, contact } = parsed.data

    // PII guard: residents/strata can only upsert the contact whose email
    // matches their own auth.users.email. Without this, a resident could
    // call create-ticket with another contact's email and the service-role
    // upsert below would overwrite first_name/last_name/mobile_e164. Staff
    // roles are exempt — legitimate on-behalf flow. Fail-closed if the
    // resident has no auth email at all (shouldn't happen with OTP login,
    // but the alternative is letting an empty string bypass the gate).

    if (
      !isStaff &&
      (!authUser.email || contact.email.toLowerCase() !== authUser.email.toLowerCase())
    ) {
      return errorResponse(
        'Forbidden: residents may only submit tickets with their own account email',
        403,
      )
    }

    // ── 2. Verify client exists ────────────────────────────────────────────

    const { data: clientRow, error: clientError } = await supabaseService
      .from('client')
      .select('id')
      .eq('id', client_id)
      .single()

    if (clientError || !clientRow) {
      return errorResponse('Client not found', 404)
    }

    // ── 3. Verify booking if provided ──────────────────────────────────────

    // The booking's address is the ticket's household for the contact rule (§4).
    let bookingPropertyId: string | null = null
    if (booking_id) {
      const { data: bookingRow, error: bookingError } = await supabaseService
        .from('booking')
        .select('id, property_id')
        .eq('id', booking_id)
        .single()

      if (bookingError || !bookingRow) {
        return errorResponse('Booking not found', 404)
      }
      bookingPropertyId = bookingRow.property_id
    }

    // ── 4. Attach contact (by email, never rewriting someone else's row) ──

    // A ticket used to overwrite whichever contact carried the email, so a
    // ticket under a shared address (the WMRC office email sat on 278 bookings)
    // renamed every booking on it (ADR 0027, #631). The ticket's household is
    // its booking's address; with no booking, only the same person — or a
    // resident's own single row — is kept. Residents/strata are "self": their
    // email is pinned to their own auth email above.
    const attached = await attachContact(supabaseService, contact, {
      household: bookingPropertyId ? { propertyId: bookingPropertyId } : 'none',
      enteredBySelf: !isStaff,
    })
    if (!attached.ok) {
      console.error('Contact attach error:', attached.error)
      return errorResponse(attached.error, 500)
    }
    const contactId = attached.contactId

    // ── 5. Generate display_id with collision retry ────────────────────────

    let displayId = ''
    const MAX_RETRIES = 5

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const candidate = generateDisplayId()
      const { data: collision } = await supabaseService
        .from('service_ticket')
        .select('id')
        .eq('display_id', candidate)
        .maybeSingle()

      if (!collision) {
        displayId = candidate
        break
      }
    }

    if (!displayId) {
      return errorResponse('Failed to generate unique ticket ID', 500)
    }

    // ── 6. Insert service_ticket ───────────────────────────────────────────

    const { data: ticketRow, error: ticketError } = await supabaseService
      .from('service_ticket')
      .insert({
        display_id: displayId,
        client_id,
        booking_id: booking_id ?? null,
        contact_id: contactId,
        subject,
        message,
        status: 'open',
        priority: 'normal',
        category,
        channel: 'portal',
      })
      .select('id')
      .single()

    if (ticketError || !ticketRow) {
      console.error('Ticket insert error:', ticketError)
      return errorResponse(`Failed to create ticket: ${ticketError?.message ?? 'unknown'}`, 500)
    }

    // Audit logging handled by audit_trigger on service_ticket table

    // ── 7. Return result ───────────────────────────────────────────────────

    return jsonResponse({ display_id: displayId })
  } catch (err) {
    console.error('create-ticket error:', err)
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
