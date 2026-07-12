import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from '../_shared/database.types.ts'
import { z } from 'https://esm.sh/zod@3.23.8'
import { corsHeaders, jsonResponse, optionsResponse, errorResponse } from '../_shared/cors.ts'

const CreateResponseRequest = z.object({
  ticket_id: z.string().uuid(),
  message: z.string().min(1).max(5000),
})

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return optionsResponse()
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return errorResponse('Unauthorized', 401)
  }

  // Authenticated client — resolves the user from the JWT
  const supabaseAuth = createClient<Database>(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  )

  // Service-role client for writes
  const supabaseService = createClient<Database>(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  try {
    // ── 1. Authenticate user ─────────────────────────────────────────────

    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser()

    if (authError || !user) {
      return errorResponse('Unauthorized', 401)
    }

    // ── 2. Parse + validate input ────────────────────────────────────────

    const body = await req.json()
    const parsed = CreateResponseRequest.safeParse(body)

    if (!parsed.success) {
      return errorResponse(parsed.error.message, 400)
    }

    const { ticket_id, message } = parsed.data

    // ── 3. Verify ticket exists and belongs to user ──────────────────────

    // Look up user's contact_id via profile
    const { data: profile } = await supabaseService
      .from('profiles')
      .select('contact_id')
      .eq('id', user.id)
      .single()

    if (!profile?.contact_id) {
      return errorResponse('Profile not linked to a contact', 403)
    }

    const { data: ticket, error: ticketError } = await supabaseService
      .from('service_ticket')
      .select('id, status, contact_id')
      .eq('id', ticket_id)
      .single()

    if (ticketError || !ticket) {
      return errorResponse('Ticket not found', 404)
    }

    if (ticket.contact_id !== profile.contact_id) {
      return errorResponse('Ticket not found', 404)
    }

    // ── 4. Check ticket is not closed/resolved ───────────────────────────

    if (ticket.status === 'closed' || ticket.status === 'resolved') {
      return errorResponse('This ticket is closed and cannot receive new replies', 400)
    }

    // ── 5. Insert response ───────────────────────────────────────────────

    const { data: response, error: insertError } = await supabaseService
      .from('ticket_response')
      .insert({
        ticket_id,
        author_id: user.id,
        author_type: 'resident',
        message,
        is_internal: false,
        channel: 'portal',
      })
      .select('id, created_at')
      .single()

    if (insertError || !response) {
      console.error('Response insert error:', insertError)
      return errorResponse(`Failed to create response: ${insertError?.message ?? 'unknown'}`, 500)
    }

    // ── 6. Update ticket status to open if it was waiting_on_customer ────

    if (ticket.status === 'waiting_on_customer') {
      await supabaseService
        .from('service_ticket')
        .update({ status: 'open' })
        .eq('id', ticket_id)
    }

    return jsonResponse({
      id: response.id,
      created_at: response.created_at,
    })
  } catch (err) {
    console.error('create-ticket-response error:', err)
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
