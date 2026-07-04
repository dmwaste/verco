import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { SURVEY_QUESTIONS } from '@/lib/survey/questions'

/** Quote a CSV cell when it contains a comma, quote, or newline. */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

interface ExportRow {
  submitted_at: string | null
  responses: Record<string, unknown> | null
  booking: {
    ref: string
    collection_area: { code: string } | null
    eligible_properties: { formatted_address: string | null } | null
  } | null
}

/**
 * CSV export of the current tenant's surveys. Scoped by the admin's selected
 * client (RLS also gates booking_survey to staff). Columns are the fixed
 * SURVEY_QUESTIONS labels, so the schema is stable across exports.
 */
export async function GET() {
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''
  const supabase = await createClient()

  let q = supabase
    .from('booking_survey')
    .select(
      `submitted_at, responses,
       booking!inner(ref, collection_area!inner(code), eligible_properties:property_id(formatted_address))`
    )
    .order('created_at', { ascending: false })
    .limit(10000)
  if (clientId) q = q.eq('client_id', clientId)
  const { data } = await q

  const header = ['Booking Ref', 'Area', 'Address', 'Submitted (UTC)', ...SURVEY_QUESTIONS.map((x) => x.label)]
  const lines = [header.map(csvCell).join(',')]

  for (const row of (data ?? []) as unknown as ExportRow[]) {
    const resp = row.responses ?? {}
    const cells = [
      row.booking?.ref ?? '',
      row.booking?.collection_area?.code ?? '',
      row.booking?.eligible_properties?.formatted_address ?? '',
      row.submitted_at ?? '',
      ...SURVEY_QUESTIONS.map((x) => resp[x.id] ?? ''),
    ]
    lines.push(cells.map(csvCell).join(','))
  }

  const slug = currentClient?.slug ?? 'surveys'
  const date = new Date().toISOString().slice(0, 10)
  return new NextResponse(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="surveys-${slug}-${date}.csv"`,
    },
  })
}
