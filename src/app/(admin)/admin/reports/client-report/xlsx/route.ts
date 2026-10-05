import { NextRequest, NextResponse } from 'next/server'
import { buildClientMonthlyReportXlsx } from '@/lib/reports/client-monthly/xlsx'
import { loadClientMonthlyReport } from '../load'

/**
 * Excel copy of the PDF statement, for office staff who re-key the numbers
 * into invoices. Same gate + load as the PDF route (loadClientMonthlyReport).
 */
export async function GET(req: NextRequest) {
  const loaded = await loadClientMonthlyReport(req.nextUrl.searchParams)
  if (!loaded.ok) return loaded.error
  const { report, labels, filenameStem } = loaded.data

  const buf = await buildClientMonthlyReportXlsx(report, labels)

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filenameStem}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  })
}
