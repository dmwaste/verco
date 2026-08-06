import { NextRequest, NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { createClient } from '@/lib/supabase/server'
import {
  buildClientMonthlyReport,
  type ReportRow,
  type OfferedService,
} from '@/lib/reports/client-monthly/report-model'
import { ClientMonthlyReportPdf } from '@/lib/reports/client-monthly/pdf'
import { parseReportParams } from './params'

/**
 * Contractor-admin only: this is an invoice-backing document for D&M's own
 * billing to the council, not a council-facing surface — client-tier staff
 * never see it.
 */
export async function GET(req: NextRequest) {
  const params = parseReportParams(
    req.nextUrl.searchParams.get('client'),
    req.nextUrl.searchParams.get('month')
  )
  if (!params.ok) return new NextResponse('Bad request', { status: 400 })
  const { clientId, month, monthStart } = params.data

  const supabase = await createClient()

  const { data: role } = await supabase.rpc('current_user_role')
  if (role !== 'contractor-admin') return new NextResponse('Forbidden', { status: 403 })

  // Never trust the public-SELECT `client` table for authorization (§21
  // switcher trap) — narrow the requested clientId through accessible_client_ids().
  const { data: accessibleIds } = await supabase.rpc('accessible_client_ids')
  if (!accessibleIds?.includes(clientId)) return new NextResponse('Forbidden', { status: 403 })

  const [clientRes, rowsRes, subClientRes, rulesRes] = await Promise.all([
    supabase
      .from('client')
      .select('slug, name, legal_name, service_name, primary_colour, accent_colour, mattress_closeout_stream')
      .eq('id', clientId)
      .single(),
    supabase.rpc('get_client_monthly_report', { p_client_id: clientId, p_month: monthStart }),
    supabase.from('sub_client').select('id').eq('client_id', clientId).limit(1),
    // Distinct services offered across ANY area of this client — mirrors the
    // getClientServices query in app/(public)/page.tsx (single FK per related
    // table on service_rules, so no multi-FK embed ambiguity). Unlike that
    // query we do NOT filter service.is_active or category 'id': a past
    // month's report must still label services that have since been retired
    // or that are illegal-dumping-only, and buildClientMonthlyReport already
    // excludes 'id' from the extras table itself.
    supabase
      .from('service_rules')
      .select(
        'service:service_id!inner(name, category:category_id!inner(code)), collection_area:collection_area_id!inner(client_id)'
      )
      .eq('collection_area.client_id', clientId),
  ])

  if (clientRes.error || !clientRes.data) return new NextResponse('Not found', { status: 404 })
  if (rowsRes.error) return new NextResponse(rowsRes.error.message, { status: 500 })
  const client = clientRes.data

  const offeredByName = new Map<string, OfferedService>()
  for (const row of rulesRes.data ?? []) {
    const svc = Array.isArray(row.service) ? row.service[0] : row.service
    if (!svc) continue
    const cat = Array.isArray(svc.category) ? svc.category[0] : svc.category
    if (!cat) continue
    offeredByName.set(svc.name, { name: svc.name, category: cat.code as OfferedService['category'] })
  }
  const offered = [...offeredByName.values()]

  const grouping = (subClientRes.data?.length ?? 0) > 0 ? ('sub_client' as const) : ('area' as const)
  const report = buildClientMonthlyReport({
    rows: (rowsRes.data ?? []) as ReportRow[],
    offered,
    grouping,
    mattressCloseoutStream: client.mattress_closeout_stream,
  })

  const [y, m] = month.split('-') as [string, string]
  const monthLabel = new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleDateString('en-AU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
  const issuedLabel = new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Perth' })
  const serviceName = client.service_name ?? client.name
  const extrasLabel = serviceName.toUpperCase().startsWith('VERCO') ? 'VERCO Extra' : `${serviceName} Extra`

  const buf = await renderToBuffer(
    ClientMonthlyReportPdf({
      report,
      monthLabel,
      refCode: `${client.slug.toUpperCase()}-${month}`,
      issuedLabel,
      serviceName,
      legalName: client.legal_name ?? client.name,
      extrasLabel,
      rowHeader: grouping === 'sub_client' ? 'Council' : 'Collection Area',
      totalRowLabel: grouping === 'sub_client' ? 'All Councils' : 'All Areas',
      primaryColour: client.primary_colour ?? '#293F52',
      accentColour: client.accent_colour ?? '#00E47C',
    })
  )

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${client.slug}-collections-${month}.pdf"`,
      'Cache-Control': 'no-store',
    },
  })
}
