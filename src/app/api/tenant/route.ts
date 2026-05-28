import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

interface TenantResponse {
  id: string
  name: string
  slug: string
  primary_colour: string | null
  accent_colour: string | null
  logo_light_url: string | null
  logo_dark_url: string | null
  service_name: string | null
  show_powered_by: boolean
}

export async function GET(request: NextRequest): Promise<NextResponse<TenantResponse | { error: string }>> {
  const clientId = request.headers.get('x-client-id')

  if (!clientId) {
    return NextResponse.json({ error: 'Missing x-client-id header' }, { status: 400 })
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('client')
    .select('id, name, slug, primary_colour, accent_colour, logo_light_url, logo_dark_url, service_name, show_powered_by')
    .eq('id', clientId)
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Client not found' }, { status: 404 })
  }

  const tenant: TenantResponse = {
    id: data.id,
    name: data.name,
    slug: data.slug,
    primary_colour: data.primary_colour,
    accent_colour: data.accent_colour,
    logo_light_url: data.logo_light_url,
    logo_dark_url: data.logo_dark_url,
    service_name: data.service_name,
    show_powered_by: data.show_powered_by,
  }

  return NextResponse.json(tenant)
}
