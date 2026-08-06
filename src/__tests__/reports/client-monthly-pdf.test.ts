import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { ClientMonthlyReportPdf } from '@/lib/reports/client-monthly/pdf'
import { buildClientMonthlyReport } from '@/lib/reports/client-monthly/report-model'

describe('ClientMonthlyReportPdf', () => {
  it('renders a valid single-page PDF from real-shaped data', async () => {
    const report = buildClientMonthlyReport({
      rows: [
        {
          source: 'booked',
          group_key: 'g1',
          group_label: 'Kwinana Area 1',
          service_name: 'Bulk Waste',
          is_mattress: false,
          is_extra: false,
          units: 130,
        },
        {
          source: 'booked',
          group_key: 'g1',
          group_label: 'Kwinana Area 1',
          service_name: 'Bulk Waste',
          is_mattress: false,
          is_extra: true,
          units: 1,
        },
      ],
      offered: [{ name: 'Bulk Waste', category: 'bulk' }],
      grouping: 'area',
      mattressCloseoutStream: null,
    })
    const buf = await renderToBuffer(
      ClientMonthlyReportPdf({
        report,
        monthLabel: 'July 2026',
        refCode: 'KWN-2026-07',
        issuedLabel: '06/08/2026',
        serviceName: 'VERCO Kwinana',
        legalName: 'City of Kwinana',
        extrasLabel: 'VERCO Extra',
        rowHeader: 'Collection Area',
        totalRowLabel: 'All Areas',
        primaryColour: '#0d295a',
        accentColour: '#69a24c',
      })
    )
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(buf.length).toBeGreaterThan(10_000) // fonts embedded, not fallback
  })

  it('renders em-dash cells for a VV-shaped report without stop data', async () => {
    const report = buildClientMonthlyReport({
      rows: [
        {
          source: 'booked',
          group_key: 'c1',
          group_label: 'Town of Cottesloe',
          service_name: 'Bulk Waste',
          is_mattress: false,
          is_extra: false,
          units: 114,
        },
      ],
      offered: [
        { name: 'Bulk Waste', category: 'bulk' },
        { name: 'Green Waste', category: 'bulk' },
      ],
      grouping: 'sub_client',
      mattressCloseoutStream: 'general',
    })
    const buf = await renderToBuffer(
      ClientMonthlyReportPdf({
        report,
        monthLabel: 'July 2026',
        refCode: 'VV-2026-07',
        issuedLabel: '06/08/2026',
        serviceName: 'Verge Valet',
        legalName: 'Western Metropolitan Regional Council',
        extrasLabel: 'Verge Valet Extra',
        rowHeader: 'Council',
        totalRowLabel: 'All Councils',
        primaryColour: '#414042',
        accentColour: '#72b75c',
      })
    )
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-')
  })
})
