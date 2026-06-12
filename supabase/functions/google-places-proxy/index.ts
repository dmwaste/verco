import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Accept both authenticated (Bearer JWT) and anonymous (anon key) requests.
  // The /book route is public — users may not have a session yet.
  // API key security is handled server-side regardless of caller auth status.
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response(
      JSON.stringify({ error: 'Missing Authorization header. Pass the anon key or a Bearer JWT.' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  const apiKey = Deno.env.get('GOOGLE_PLACES_API_KEY')
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'Google Places API key not configured' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  try {
    const body = await req.json()

    // Reverse geocode mode
    if (body.latlng && body.type === 'reverse') {
      const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
      url.searchParams.set('latlng', body.latlng)
      url.searchParams.set('key', apiKey)
      url.searchParams.set('result_type', 'street_address|route')

      const res = await fetch(url.toString())
      const data = await res.json()

      const address = data.results?.[0]?.formatted_address ?? null

      return new Response(
        JSON.stringify({ address }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Place geocode mode — resolve an autocomplete place_id to coordinates.
    // Used by the admin ID request form, where office staff pick an address
    // but the booking RPC needs latitude/longitude. Emits address/latitude/
    // longitude on every path; error is set on failures so callers can
    // distinguish "no result" from "lookup service failed".
    if (body.type === 'geocode') {
      const placeId = typeof body.place_id === 'string' ? body.place_id : ''
      // Google place_ids are short base64-ish tokens — reject junk early.
      if (!/^[A-Za-z0-9_-]{10,300}$/.test(placeId)) {
        return new Response(
          JSON.stringify({ address: null, latitude: null, longitude: null, error: 'Invalid place_id' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
      url.searchParams.set('place_id', placeId)
      url.searchParams.set('key', apiKey)

      const res = await fetch(url.toString())
      const data = await res.json()

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        console.error('Google Geocoding API error:', data.status, data.error_message)
        return new Response(
          JSON.stringify({
            address: null,
            latitude: null,
            longitude: null,
            error: data.error_message ?? data.status,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const result = data.results?.[0] ?? null
      const location = result?.geometry?.location ?? null

      return new Response(
        JSON.stringify({
          address: result?.formatted_address ?? null,
          latitude: location?.lat ?? null,
          longitude: location?.lng ?? null,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Autocomplete mode
    const { input, session_token, types, components, state } = body as {
      input: string
      session_token?: string
      types?: string
      components?: string
      state?: string
    }

    if (!input || input.length < 2) {
      return new Response(
        JSON.stringify({ predictions: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // State biasing + restriction. D&M operates WA-only, so callers pass
    // `state: 'WA'` to (a) bias Google's ranking toward the state's population
    // centre — a server-side proxy carries no caller location, so without this
    // a common street name (e.g. "Grant St") surfaces interstate matches ahead
    // of the WA one — and (b) hard-filter the returned descriptions to that
    // state so nothing interstate is ever shown. Allowlisted: the regex below
    // is built only from a known state key, never raw input.
    const STATE_BIAS: Record<string, { location: string; radius: number }> = {
      WA: { location: '-31.9523,115.8613', radius: 200000 }, // Perth metro — covers all current tenants
    }
    const stateKey = state && state in STATE_BIAS ? state : undefined

    const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json')
    url.searchParams.set('input', input)
    url.searchParams.set('key', apiKey)

    if (types) url.searchParams.set('types', types)
    if (components) url.searchParams.set('components', components)
    if (session_token) url.searchParams.set('sessiontoken', session_token)
    if (stateKey) {
      url.searchParams.set('location', STATE_BIAS[stateKey].location)
      url.searchParams.set('radius', String(STATE_BIAS[stateKey].radius))
    }

    const res = await fetch(url.toString())
    const data = await res.json()

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.error('Google Places API error:', data.status, data.error_message)
      return new Response(
        JSON.stringify({ predictions: [], error: data.error_message ?? data.status }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Filter to only return place_id and description, then enforce the state
    // restriction. AU autocomplete descriptions carry the state abbreviation
    // (e.g. "6 Grant Street, Cottesloe WA 6011, Australia"); no other AU state
    // token contains "WA", so a word-boundary match is unambiguous.
    let predictions = (data.predictions ?? []).map(
      (p: { place_id: string; description: string }) => ({
        place_id: p.place_id,
        description: p.description,
      })
    )
    if (stateKey) {
      const stateRe = new RegExp(`\\b${stateKey}\\b`)
      predictions = predictions.filter((p: { description: string }) =>
        stateRe.test(p.description)
      )
    }

    return new Response(
      JSON.stringify({ predictions }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('google-places-proxy error:', err)
    return new Response(
      JSON.stringify({ error: 'Internal Server Error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
