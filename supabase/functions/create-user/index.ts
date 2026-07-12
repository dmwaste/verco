import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database, TablesInsert, TablesUpdate } from '../_shared/database.types.ts'
import { z } from 'https://esm.sh/zod@3.23.8'
import { corsHeaders, jsonResponse, optionsResponse, errorResponse } from '../_shared/cors.ts'
import { sendEmail } from '../_shared/sendgrid.ts'

// ── Role classification ─────────────────────────────────────────────────────

const CONTRACTOR_ROLES = ['contractor-admin', 'contractor-staff', 'field'] as const
const CLIENT_ROLES = ['client-admin', 'client-staff', 'ranger'] as const
const END_USER_ROLES = ['resident', 'strata'] as const
const ALL_ROLES = [...CONTRACTOR_ROLES, ...CLIENT_ROLES, ...END_USER_ROLES] as const

const ROLE_LABELS: Record<string, string> = {
  'contractor-admin': 'Contractor Admin',
  'contractor-staff': 'Contractor Staff',
  field: 'Contractor Field',
  'client-admin': 'Client Admin',
  'client-staff': 'Client Staff',
  ranger: 'Client Ranger',
  resident: 'Resident',
  strata: 'Strata',
}

function isContractorRole(role: string): boolean {
  return (CONTRACTOR_ROLES as readonly string[]).includes(role)
}

function isClientRole(role: string): boolean {
  return (CLIENT_ROLES as readonly string[]).includes(role)
}

// ── Input validation ────────────────────────────────────────────────────────

const CreateUserRequest = z
  .object({
    first_name: z.string().min(1).max(100),
    last_name: z.string().min(1).max(100),
    email: z.string().email().max(320),
    mobile_e164: z.string().regex(/^\+614\d{8}$/).optional(),
    role: z.enum(ALL_ROLES),
    contractor_id: z.string().uuid().optional(),
    client_id: z.string().uuid().optional(),
    // VER-216 — optional sub-client scope. Only meaningful for client-tier
    // roles. The DB has a composite FK enforcing (sub_client_id, client_id)
    // must reference an existing sub_client row, so a bad pairing is
    // rejected at insert. We validate here for a clearer error message.
    sub_client_id: z.string().uuid().optional(),
    // MUD property bindings written to strata_user_properties. Required when role = strata.
    mud_property_ids: z.string().uuid().array().optional(),
  })
  .refine(
    (data) => {
      if (isContractorRole(data.role)) return !!data.contractor_id
      if (isClientRole(data.role)) return !!data.client_id
      if (data.role === 'strata') return !!data.client_id
      return true
    },
    {
      message: 'Contractor roles require contractor_id; client and strata roles require client_id.',
    }
  )
  .refine(
    (data) => !data.sub_client_id || isClientRole(data.role),
    {
      message: 'sub_client_id is only valid for client-tier roles (client-admin, client-staff, ranger).',
      path: ['sub_client_id'],
    }
  )
  .refine(
    (data) => data.role !== 'strata' || (!!data.mud_property_ids && data.mud_property_ids.length > 0),
    {
      message: 'Strata users require at least one MUD property.',
      path: ['mud_property_ids'],
    }
  )

// ── Handler ─────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return optionsResponse()
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return errorResponse('Unauthorized', 401)
  }

  // Caller client — uses the caller's JWT, respects RLS
  const supabaseCaller = createClient<Database>(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  )

  // Service-role client — for auth.admin + writes
  const supabaseService = createClient<Database>(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  try {
    // ── 1. Permission check ─────────────────────────────────────────────

    const { data: callerRole } = await supabaseCaller.rpc('current_user_role')
    if (!callerRole || !['contractor-admin', 'client-admin'].includes(callerRole)) {
      return errorResponse('Only contractor-admin and client-admin can create users.', 403)
    }

    // ── 2. Parse + validate input ───────────────────────────────────────

    const body = await req.json()
    const parsed = CreateUserRequest.safeParse(body)
    if (!parsed.success) {
      return errorResponse(parsed.error.message, 400)
    }

    const { first_name, last_name, email, mobile_e164, role, contractor_id, client_id, sub_client_id, mud_property_ids } = parsed.data
    // Derived once; used for non-contacts surfaces (auth metadata, profile
    // display name, welcome email, audit log). The contacts table itself
    // gets first/last only — full_name is generated.
    const full_name = `${first_name} ${last_name}`.trim()

    // ── 3. Scope check — client-admin restrictions ──────────────────────

    if (callerRole === 'client-admin') {
      // Client-admin can create client-tier roles and strata end-users
      if (!isClientRole(role) && role !== 'strata') {
        return errorResponse('Client admins can only create client-tier roles (client-admin, client-staff, ranger) or strata users.', 403)
      }
      // Must be scoped to their own client (applies to both client-tier and strata)
      const { data: callerClientId } = await supabaseCaller.rpc('current_user_client_id')
      if (!callerClientId || callerClientId !== client_id) {
        return errorResponse('You can only create users for your own client.', 403)
      }
      // VER-216 — if the caller is themselves sub-client-scoped, the new
      // client-tier user must be scoped to the same sub-client. Strata users
      // are property-bound (not sub-client-scoped), so skip this check for them.
      if (isClientRole(role)) {
        const { data: callerSubClientId } = await supabaseCaller.rpc('current_user_sub_client_id')
        if (callerSubClientId && callerSubClientId !== sub_client_id) {
          return errorResponse('You can only create users scoped to your own sub-client.', 403)
        }
      }
    }

    // ── 4. Verify tenant exists ─────────────────────────────────────────

    if (contractor_id) {
      const { data: row, error } = await supabaseService
        .from('contractor')
        .select('id, name')
        .eq('id', contractor_id)
        .single()
      if (error || !row) return errorResponse('Contractor not found.', 404)
    }

    let tenantName = ''
    let tenantCustomDomain: string | null = null
    let tenantSlug: string | null = null

    if (client_id) {
      const { data: row, error } = await supabaseService
        .from('client')
        .select('id, name, custom_domain, slug')
        .eq('id', client_id)
        .single()
      if (error || !row) return errorResponse('Client not found.', 404)
      tenantName = row.name
      tenantCustomDomain = row.custom_domain
      tenantSlug = row.slug
    }

    // VER-216 — validate sub_client_id belongs to the supplied client_id.
    // The DB has a composite FK that would reject the mismatch on insert,
    // but the error message there is opaque; this check returns a clean
    // 400 with a helpful message.
    if (sub_client_id) {
      const { data: subClientRow, error: subClientErr } = await supabaseService
        .from('sub_client')
        .select('id, client_id')
        .eq('id', sub_client_id)
        .single()
      if (subClientErr || !subClientRow) {
        return errorResponse('Sub-client not found.', 404)
      }
      if (subClientRow.client_id !== client_id) {
        return errorResponse('Sub-client does not belong to the supplied client.', 400)
      }
    }

    if (contractor_id && !tenantName) {
      const { data: row } = await supabaseService
        .from('contractor')
        .select('name')
        .eq('id', contractor_id)
        .single()
      tenantName = row?.name ?? ''
    }

    // ── 5. Create or find auth user ─────────────────────────────────────

    let authUserId: string

    // Try to create — if email already exists, Supabase returns a duplicate error
    const { data: newUser, error: createError } = await supabaseService.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { full_name },
    })

    if (createError) {
      const msg = createError.message ?? ''
      const isDuplicate = msg.includes('already been registered') || msg.includes('already exists')

      if (isDuplicate) {
        // Look up existing user via profiles table
        const { data: existingProfile } = await supabaseService
          .from('profiles')
          .select('id')
          .eq('email', email)
          .maybeSingle()

        if (existingProfile) {
          authUserId = existingProfile.id
        } else {
          return errorResponse('A user with this email already exists in auth but has no profile. Contact support.', 409)
        }
      } else {
        console.error('Auth user creation error:', createError)
        return errorResponse(`Failed to create auth user: ${msg}`, 500)
      }
    } else {
      authUserId = newUser.user.id
    }

    // ── 6. Upsert contact ───────────────────────────────────────────────

    const { data: existingContact } = await supabaseService
      .from('contacts')
      .select('id')
      .eq('email', email)
      .maybeSingle()

    let contactId: string

    if (existingContact) {
      // full_name is a generated column — must write first/last_name.
      const updateData: TablesUpdate<'contacts'> = { first_name, last_name }
      if (mobile_e164) updateData.mobile_e164 = mobile_e164

      const { error: updateError } = await supabaseService
        .from('contacts')
        .update(updateData)
        .eq('id', existingContact.id)

      if (updateError) {
        console.error('Contact update error:', updateError)
        return errorResponse('Failed to update contact.', 500)
      }

      contactId = existingContact.id
    } else {
      const insertData: TablesInsert<'contacts'> = { first_name, last_name, email }
      if (mobile_e164) insertData.mobile_e164 = mobile_e164

      const { data: newContact, error: insertError } = await supabaseService
        .from('contacts')
        .insert(insertData)
        .select('id')
        .single()

      if (insertError || !newContact) {
        console.error('Contact insert error:', insertError)
        return errorResponse('Failed to create contact.', 500)
      }

      contactId = newContact.id
    }

    // ── 7. Upsert profile ───────────────────────────────────────────────

    const { error: profileError } = await supabaseService
      .from('profiles')
      .upsert(
        {
          id: authUserId,
          email,
          display_name: full_name,
          contact_id: contactId,
        },
        { onConflict: 'id' }
      )

    if (profileError) {
      console.error('Profile upsert error:', profileError)
      return errorResponse(`Failed to create profile: ${profileError.message}`, 500)
    }

    // ── 8. Upsert user_role (update if exists, insert if not) ──────────

    // user_id is added at insert time (spread below); update reuses the same
    // fields, so type as the Insert shape minus user_id.
    const roleData: Omit<TablesInsert<'user_roles'>, 'user_id'> = {
      role,
      is_active: true,
      contractor_id: contractor_id ?? null,
      client_id: client_id ?? null,
      // VER-216 — sub-client scope. NULL = full client scope.
      sub_client_id: sub_client_id ?? null,
    }

    const { data: existingRole } = await supabaseService
      .from('user_roles')
      .select('id')
      .eq('user_id', authUserId)
      .maybeSingle()

    if (existingRole) {
      const { error: updateError } = await supabaseService
        .from('user_roles')
        .update(roleData)
        .eq('id', existingRole.id)

      if (updateError) {
        console.error('user_roles update error:', updateError)
        return errorResponse(`Failed to update role: ${updateError.message}`, 500)
      }
    } else {
      const { error: insertError } = await supabaseService
        .from('user_roles')
        .insert({ user_id: authUserId, ...roleData })

      if (insertError) {
        console.error('user_roles insert error:', insertError)
        return errorResponse(`Failed to assign role: ${insertError.message}`, 500)
      }
    }

    // ── 8b. Write MUD property bindings for strata users ───────────────
    // mud_property_ids is validated non-empty when role === 'strata'.
    // Upsert (not insert) so the EF is idempotent if the same user is re-created.

    if (role === 'strata' && mud_property_ids && mud_property_ids.length > 0) {
      const rows = mud_property_ids.map((property_id) => ({
        user_id: authUserId,
        property_id,
      }))

      const { error: bindError } = await supabaseService
        .from('strata_user_properties')
        .upsert(rows, { onConflict: 'user_id,property_id' })

      if (bindError) {
        console.error('strata_user_properties upsert error:', bindError)
        return errorResponse(`Failed to assign MUD properties: ${bindError.message}`, 500)
      }
    }

    // ── 9. Send confirmation email (non-blocking) ───────────────────────

    const roleLabel = ROLE_LABELS[role] ?? role

    // Resolve the login URL to the user's tenant subdomain. The SITE_URL
    // env var / verco.au fallback points to the marketing site (no /auth
    // route) — clicking the welcome-email button there 404s. Per-tenant
    // resolution mirrors the proxy logic: custom_domain → slug.verco.au.
    let loginBaseUrl: string
    if (client_id && tenantCustomDomain) {
      loginBaseUrl = `https://${tenantCustomDomain}`
    } else if (client_id && tenantSlug) {
      loginBaseUrl = `https://${tenantSlug}.verco.au`
    } else {
      // Contractor roles have no canonical tenant subdomain — the proxy
      // resolves them by whichever hostname they land on. Fall back to
      // SITE_URL; follow-up if this surfaces during UAT.
      loginBaseUrl = Deno.env.get('SITE_URL') ?? 'https://verco.au'
    }

    sendEmail({
      to: { email, name: full_name },
      from: { email: 'noreply@verco.au', name: 'Verco' },
      subject: 'Your Verco account has been created',
      htmlBody: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #293F52; margin-bottom: 16px;">Welcome to Verco</h2>
          <p>Hi ${full_name},</p>
          <p>An account has been created for you with the following details:</p>
          <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
            <tr>
              <td style="padding: 8px 12px; border: 1px solid #eee; font-weight: 600; color: #293F52;">Role</td>
              <td style="padding: 8px 12px; border: 1px solid #eee;">${roleLabel}</td>
            </tr>
            ${tenantName ? `
            <tr>
              <td style="padding: 8px 12px; border: 1px solid #eee; font-weight: 600; color: #293F52;">Organisation</td>
              <td style="padding: 8px 12px; border: 1px solid #eee;">${tenantName}</td>
            </tr>` : ''}
            <tr>
              <td style="padding: 8px 12px; border: 1px solid #eee; font-weight: 600; color: #293F52;">Email</td>
              <td style="padding: 8px 12px; border: 1px solid #eee;">${email}</td>
            </tr>
          </table>
          <p>You can log in using your email address — a one-time code will be sent to verify your identity.</p>
          <a href="${loginBaseUrl}/auth" style="display: inline-block; margin-top: 12px; padding: 12px 24px; background: #293F52; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600;">Log In</a>
          <p style="margin-top: 24px; font-size: 13px; color: #888;">If you did not expect this email, please ignore it.</p>
        </div>
      `,
    }).then((result) => {
      if (!result.ok) {
        console.warn('Confirmation email failed (non-blocking):', result.error)
      }
    })

    // ── 10. Audit log (non-blocking) ────────────────────────────────────

    supabaseService
      .from('audit_log')
      .insert({
        table_name: 'user_roles',
        record_id: authUserId,
        action: 'INSERT',
        new_data: { role, email, full_name },
        client_id: client_id ?? null,
      })
      .then(({ error }) => {
        if (error) console.error('Audit log insert error (non-blocking):', error)
      })

    // ── 11. Return result ───────────────────────────────────────────────

    return jsonResponse({ user_id: authUserId, email, role })
  } catch (err) {
    console.error('create-user error:', err)
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
