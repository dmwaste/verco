import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from '../_shared/database.types.ts'
import { z } from 'https://esm.sh/zod@3.23.8'
import { calculatePrice } from '../_shared/pricing.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const BookingItemInput = z.object({
  service_id: z.string().uuid(),
  collection_date_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(10),
})

const PriceCalculationRequest = z.object({
  property_id: z.string().uuid(),
  fy_id: z.string().uuid(),
  items: z.array(BookingItemInput).min(1).max(20),
  // Admin "Edit services" flow — when present, the booking being replaced
  // is excluded from the FY-usage count so the new selection is priced as
  // a replacement rather than an addition.
  replaces: z.string().uuid().optional(),
})

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders })
  }

  const supabase = createClient<Database>(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  )

  try {
    const body = await req.json()
    const parsed = PriceCalculationRequest.safeParse(body)

    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { property_id, fy_id, items, replaces } = parsed.data

    // Resolve property → collection_area_id + MUD unit count
    const { data: property, error: propError } = await supabase
      .from('eligible_properties')
      .select('collection_area_id, is_mud, unit_count')
      .eq('id', property_id)
      .single()

    // collection_area_id is nullable in the schema; a property with no area can't
    // be priced (no allocation rules resolve), so reject it like a missing property.
    if (propError || !property || !property.collection_area_id) {
      return new Response(
        JSON.stringify({ error: 'Property not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // MUD properties: allocations scale by unit count
    const unitMultiplier = property.is_mud && property.unit_count > 0 ? property.unit_count : 1

    const pricingItems = items.map((i) => ({
      service_id: i.service_id,
      quantity: i.quantity,
    }))

    const result = await calculatePrice(
      supabase,
      property_id,
      property.collection_area_id,
      fy_id,
      pricingItems,
      replaces,
      unitMultiplier,
    )

    // Re-attach collection_date_id to line items for the caller
    const lineItemsWithDate = result.line_items.map((li, idx) => ({
      service_id: li.service_id,
      collection_date_id: items[idx]!.collection_date_id,
      quantity: li.quantity,
      free_units: li.free_units,
      paid_units: li.paid_units,
      unit_price_cents: li.unit_price_cents,
      line_charge_cents: li.line_charge_cents,
      is_extra: li.is_extra,
    }))

    return new Response(
      JSON.stringify({
        line_items: lineItemsWithDate,
        total_cents: result.total_cents,
        override_applied: result.override_applied,
        override_reason: result.override_reason,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('calculate-price error:', err)
    return new Response(
      JSON.stringify({ error: 'Internal Server Error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
