import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from '../_shared/database.types.ts'
import { jsonResponse, optionsResponse, errorResponse } from '../_shared/cors.ts'

type RequestBody = {
  // Cap the number of rows processed in one invocation. Default: all matching.
  // Useful for chunking large backfills under the 150s EF wall-clock limit.
  limit?: number
  // Skip the UPDATE — emit what would have been written. For smoke testing.
  dry_run?: boolean
  // Also call Places Autocomplete with the same address and compare place_ids.
  // Validates that Geocoding API and Places Autocomplete agree on the place_id
  // for an address before we commit a bulk re-geocode.
  compare_autocomplete?: boolean
  // Restrict to a single external_source — used to stratify smoke tests
  // across import sources (Main/SUB/VIC). Default: all sources.
  external_source?: string
}

type GeocodeOutcome =
  | {
      id: string
      success: true
      placeId: string
      latitude: number
      longitude: number
      googleFormattedAddress: string
      autocompletePlaceId: string | null
      autocompleteDescription: string | null
      autocompleteStatus: string
    }
  | { id: string; success: false; error: string }

// Dual auth: service-role bearer for CLI/cron callers (import scripts),
// OR a valid user JWT with an admin role for any admin-UI caller.
// Presence-only auth would let any anon-key holder mutate eligible_properties
// or burn Google Places spend.
const ADMIN_ROLES = ['contractor-admin', 'client-admin'] as const

serve(async (req) => {
  // Browser callers (the admin "Geocode All" button) send a CORS preflight
  // first. Without this short-circuit the OPTIONS request falls through to the
  // no-auth-header branch below and 401s with no Access-Control-Allow-Origin,
  // so the browser blocks the real POST. Every other browser-facing EF handles
  // this via _shared/cors.ts — geocode-properties was the lone exception.
  if (req.method === 'OPTIONS') return optionsResponse()

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return errorResponse('Unauthorized', 401)
  }

  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!serviceRoleKey || !supabaseUrl || !anonKey) {
    // Without these, the bearer comparison below would coerce undefined to
    // the literal string "undefined" and any caller posting "Bearer undefined"
    // would skip the user-role check.
    return errorResponse('Server misconfiguration: missing Supabase env vars', 500)
  }
  const bearer = authHeader.replace(/^Bearer\s+/i, '')

  // Service-role direct match: CLI / cron callers bypass user-role check.
  // Otherwise validate the user JWT and gate on admin roles.
  if (bearer !== serviceRoleKey) {
    const supabaseUser = createClient<Database>(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: userData, error: userError } = await supabaseUser.auth.getUser()
    if (userError || !userData.user) {
      return errorResponse('Unauthorized', 401)
    }
    const { data: roleData, error: roleError } = await supabaseUser.rpc('current_user_role')
    if (roleError) {
      // Server-side problem (RPC failed) — surface as 500, not 401.
      return errorResponse(`Role lookup failed: ${roleError.message}`, 500)
    }
    if (!roleData || !ADMIN_ROLES.includes(roleData as (typeof ADMIN_ROLES)[number])) {
      return errorResponse('Forbidden: contractor-admin or client-admin only', 403)
    }
  }

  const supabase = createClient<Database>(supabaseUrl, serviceRoleKey)

  const apiKey = Deno.env.get('GOOGLE_PLACES_API_KEY')
  if (!apiKey) {
    return errorResponse('Google Places API key not configured', 500)
  }

  let body: RequestBody = {}
  try {
    body = await req.json()
  } catch {
    // Empty/invalid body is fine — all params are optional.
  }
  const limit =
    typeof body.limit === 'number' ? Math.max(1, Math.min(body.limit, 50_000)) : null
  const dryRun = body.dry_run === true
  const compareAutocomplete = body.compare_autocomplete === true
  const externalSource = typeof body.external_source === 'string' ? body.external_source : null

  // Catches rows missing place_id regardless of has_geocode state. The Main VV
  // import populated lat/long from Airtable without calling Geocoding, so
  // ~66K rows have has_geocode=true but google_place_id=null — and the
  // booking autocomplete primary-path lookup is keyed on google_place_id.
  let query = supabase
    .from('eligible_properties')
    .select('id, address, formatted_address, external_source')
    .is('google_place_id', null)
    .order('created_at', { ascending: true })

  if (externalSource) query = query.eq('external_source', externalSource)

  // For smoke tests with compareAutocomplete: oversample then shuffle so the
  // 50-row sample spans Main/SUB/VIC by chance rather than all-from-oldest.
  const oversample = compareAutocomplete && limit ? Math.min(limit * 5, 50_000) : limit
  if (oversample) query = query.limit(oversample)

  const { data: fetched, error: fetchError } = await query
  if (fetchError) {
    return errorResponse(fetchError.message, 500)
  }
  if (!fetched || fetched.length === 0) {
    // `failed: 0` keeps the response shape stable so the chunked-loop runner's
    // parseEfResponse() recognises this as a clean done-signal, not a malformed
    // envelope (which would trip the consecutive-failures abort path).
    return jsonResponse({
      message: 'No properties missing google_place_id',
      processed: 0,
      total: 0,
      failed: 0,
    })
  }

  const properties =
    compareAutocomplete && limit ? shuffle(fetched).slice(0, limit) : fetched

  const BATCH_SIZE = 10
  const DELAY_MS = 100
  let processed = 0
  let failed = 0
  const errors: Array<{ id: string; error: string }> = []
  const parity: Array<{
    id: string
    address: string
    external_source: string | null
    geocode_place_id: string
    geocode_formatted_address: string
    autocomplete_place_id: string | null
    autocomplete_description: string | null
    autocomplete_status: string
    match: boolean
  }> = []

  for (let i = 0; i < properties.length; i += BATCH_SIZE) {
    const batch = properties.slice(i, i + BATCH_SIZE)

    const results: GeocodeOutcome[] = await Promise.all(
      batch.map(async (prop): Promise<GeocodeOutcome> => {
        const address = prop.formatted_address ?? prop.address
        try {
          const geoUrl = new URL('https://maps.googleapis.com/maps/api/geocode/json')
          geoUrl.searchParams.set('address', address)
          geoUrl.searchParams.set('key', apiKey)
          geoUrl.searchParams.set('components', 'country:AU')

          const geoRes = await fetch(geoUrl.toString())
          const geoData = await geoRes.json()
          if (geoData.status !== 'OK' || !geoData.results?.[0]) {
            return {
              id: prop.id,
              success: false,
              error: `Geocode: ${geoData.status}${
                geoData.error_message ? ` (${geoData.error_message})` : ''
              }`,
            }
          }
          const result = geoData.results[0]
          const location = result.geometry.location as { lat: number; lng: number }
          const placeId = result.place_id as string
          // Strip Geocoding's premise prefix ("Unit 18/346 ..." → "18/346 ...").
          // The autocomplete description never has these, so the ILIKE fallback
          // would miss without normalising one side.
          const googleFormattedAddress = stripPremisePrefix(
            result.formatted_address as string
          )

          let autocompletePlaceId: string | null = null
          let autocompleteDescription: string | null = null
          let autocompleteStatus = 'SKIPPED'
          if (compareAutocomplete) {
            const acUrl = new URL(
              'https://maps.googleapis.com/maps/api/place/autocomplete/json'
            )
            acUrl.searchParams.set('input', address)
            acUrl.searchParams.set('key', apiKey)
            acUrl.searchParams.set('components', 'country:au')
            const acRes = await fetch(acUrl.toString())
            const acData = await acRes.json()
            autocompleteStatus = acData.status ?? 'UNKNOWN'
            autocompletePlaceId = acData.predictions?.[0]?.place_id ?? null
            autocompleteDescription = acData.predictions?.[0]?.description ?? null
          }

          if (!dryRun) {
            // Overwrite formatted_address with Google's canonical form. The
            // booking-flow ILIKE fallback ([address-form.tsx]:64-88) reduces
            // the resident's typed address to its first two comma parts and
            // substring-matches against formatted_address — that only works
            // when both sides are in the same canonical format.
            const { error: updateError } = await supabase
              .from('eligible_properties')
              .update({
                latitude: location.lat,
                longitude: location.lng,
                google_place_id: placeId,
                formatted_address: googleFormattedAddress,
                has_geocode: true,
              })
              .eq('id', prop.id)
            if (updateError) {
              return { id: prop.id, success: false, error: updateError.message }
            }
          }

          return {
            id: prop.id,
            success: true,
            placeId,
            latitude: location.lat,
            longitude: location.lng,
            googleFormattedAddress,
            autocompletePlaceId,
            autocompleteDescription,
            autocompleteStatus,
          }
        } catch (err) {
          return {
            id: prop.id,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      })
    )

    for (let j = 0; j < results.length; j++) {
      const r = results[j]!
      const prop = batch[j]!
      if (r.success) {
        processed++
        if (compareAutocomplete) {
          parity.push({
            id: r.id,
            address: prop.formatted_address ?? prop.address,
            external_source: prop.external_source,
            geocode_place_id: r.placeId,
            geocode_formatted_address: r.googleFormattedAddress,
            autocomplete_place_id: r.autocompletePlaceId,
            autocomplete_description: r.autocompleteDescription,
            autocomplete_status: r.autocompleteStatus,
            match: r.autocompletePlaceId === r.placeId,
          })
        }
      } else {
        failed++
        errors.push({ id: r.id, error: r.error })
      }
    }

    if (i + BATCH_SIZE < properties.length) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS))
    }
  }

  const response: Record<string, unknown> = {
    message: `${dryRun ? 'DRY RUN — ' : ''}Geocoding complete. ${processed} succeeded${
      dryRun ? ' (no writes)' : ' (written)'
    }, ${failed} failed.`,
    total: properties.length,
    processed,
    failed,
    dry_run: dryRun,
  }
  if (errors.length > 0) response.errors = errors.slice(0, 20)
  if (compareAutocomplete) {
    const matches = parity.filter((p) => p.match).length
    const bySource: Record<string, { total: number; matches: number }> = {}
    for (const p of parity) {
      const key = p.external_source ?? '(null)'
      bySource[key] ??= { total: 0, matches: 0 }
      bySource[key].total++
      if (p.match) bySource[key].matches++
    }
    response.parity = {
      sample_size: parity.length,
      matches,
      mismatches: parity.length - matches,
      match_rate_pct:
        parity.length > 0 ? Math.round((1000 * matches) / parity.length) / 10 : 0,
      by_source: bySource,
      all_samples: parity,
    }
  }

  // Per CLAUDE.md §11: if invoked as a cron, pg_cron only sees HTTP status,
  // so a 200 with `failed > 0` would silently hide partial failures from
  // job-run details. Return 500 on partial failure; the chunked-loop runner
  // parses the body regardless of status (scripts/run-geocode-loop.ts:170).
  // Dry runs and clean completions stay on 200.
  const status = !dryRun && failed > 0 ? 500 : 200
  return jsonResponse(response, status)
})

function stripPremisePrefix(s: string): string {
  return s.replace(/^(Unit|Flat|Townhouse|Apartment|Suite|Apt) +/i, '')
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}
