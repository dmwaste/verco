import { NextRequest, NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { ClientMonthlyReportPdf } from '@/lib/reports/client-monthly/pdf'
import { loadClientMonthlyReport } from '../load'

/** Contractor-admin only — the gate + tenant check live in loadClientMonthlyReport. */
export async function GET(req: NextRequest) {
  const loaded = await loadClientMonthlyReport(req.nextUrl.searchParams)
  if (!loaded.ok) return loaded.error
  const { report, labels, filenameStem } = loaded.data

  const buf = await renderToBuffer(ClientMonthlyReportPdf({ report, ...labels }))

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filenameStem}.pdf"`,
      'Cache-Control': 'no-store',
    },
  })
}
