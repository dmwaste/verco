// @vitest-environment node
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import {
  buildClientMonthlyReport,
  type ClientMonthlyReport,
  type ReportLabels,
  type ReportRow,
  type ReportTable,
} from '@/lib/reports/client-monthly/report-model'
import { buildClientMonthlyReportXlsx, TABLE_HEADER_ROW } from '@/lib/reports/client-monthly/xlsx'

/**
 * The Excel statement is the same invoice-backing document as the PDF, so
 * every number in it must tie out to the ReportTable the PDF renders — the
 * two downloads can never disagree. Null cells (the PDF's em-dash, "no data")
 * must be EMPTY cells: never 0, never the string '—'.
 */

const row = (over: Partial<ReportRow>): ReportRow => ({
  source: 'booked', group_key: 'g1', group_label: 'Kwinana Area 1',
  service_name: 'Bulk Waste', is_mattress: false, is_extra: false, units: 1,
  ...over,
})

const VV_LABELS: ReportLabels = {
  monthLabel: 'September 2026',
  refCode: 'VV-2026-09',
  issuedLabel: '05/10/2026',
  serviceName: 'Verge Valet',
  legalName: 'Western Metropolitan Regional Council',
  extrasLabel: 'Verge Valet Extra',
  rowHeader: 'Council',
  totalRowLabel: 'All Councils',
  primaryColour: '#414042',
  accentColour: '#72b75c',
}

const KWN_LABELS: ReportLabels = {
  ...VV_LABELS,
  refCode: 'KWN-2026-09',
  serviceName: 'VERCO Kwinana',
  legalName: 'City of Kwinana',
  extrasLabel: 'VERCO Extra',
  rowHeader: 'Collection Area',
  totalRowLabel: 'All Areas',
  primaryColour: '#0d295a',
}

// VV-shaped: grouped by council, mattresses logged at closeout but NO stop
// data this month -> the Mattress column is null (em-dash) in the PDF.
const VV_NO_STOPS = buildClientMonthlyReport({
  rows: [
    row({ group_key: 'cot', group_label: 'Town of Cottesloe', units: 114 }),
    row({ group_key: 'cot', group_label: 'Town of Cottesloe', service_name: 'Green Waste', units: 37 }),
    row({ group_key: 'mos', group_label: 'Town of Mosman Park', units: 1210 }),
    row({ group_key: 'mos', group_label: 'Town of Mosman Park', is_extra: true, units: 3 }),
  ],
  offered: [
    { name: 'Bulk Waste', category: 'bulk' },
    { name: 'Green Waste', category: 'bulk' },
  ],
  grouping: 'sub_client',
  mattressCloseoutStream: 'general',
})

// VV-shaped WITH crew-logged mattress counts.
const VV_WITH_STOPS = buildClientMonthlyReport({
  rows: [
    row({ group_key: 'cot', group_label: 'Town of Cottesloe', units: 114 }),
    row({ group_key: 'cot', group_label: 'Town of Cottesloe', source: 'stop_mattress', units: 9 }),
    row({ group_key: 'vin', group_label: 'City of Vincent', units: 88 }),
  ],
  offered: [{ name: 'Bulk Waste', category: 'bulk' }],
  grouping: 'sub_client',
  mattressCloseoutStream: 'general',
})

// KWN-shaped: grouped by area, ancillary + ID columns, paid extras.
const KWN = buildClientMonthlyReport({
  rows: [
    row({ units: 130 }),
    row({ service_name: 'Green Waste', units: 105 }),
    row({ service_name: 'Mattress', is_mattress: true, units: 12 }),
    row({ service_name: 'Illegal Dumping', units: 4 }),
    row({ group_key: 'g2', group_label: 'Kwinana Area 2', units: 152 }),
    row({ group_key: 'g2', group_label: 'Kwinana Area 2', is_extra: true, units: 2 }),
    row({ group_key: 'g2', group_label: 'Kwinana Area 2', service_name: 'E-Waste', is_extra: true, units: 1 }),
  ],
  offered: [
    { name: 'Bulk Waste', category: 'bulk' },
    { name: 'Green Waste', category: 'bulk' },
    { name: 'E-Waste', category: 'anc' },
    { name: 'Mattress', category: 'anc' },
    { name: 'Illegal Dumping', category: 'id' },
  ],
  grouping: 'area',
  mattressCloseoutStream: null,
})

const EMPTY_MONTH = buildClientMonthlyReport({
  rows: [],
  offered: [{ name: 'Bulk Waste', category: 'bulk' }],
  grouping: 'area',
  mattressCloseoutStream: null,
})

async function load(report: ClientMonthlyReport, labels: ReportLabels) {
  const buf = await buildClientMonthlyReportXlsx(report, labels)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer)
  return wb
}

function sheet(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const ws = wb.getWorksheet(name)
  if (!ws) throw new Error(`missing sheet ${name}`)
  return ws
}

/** Asserts every cell of the sheet's table equals the ReportTable the PDF renders. */
function expectTiesOut(ws: ExcelJS.Worksheet, table: ReportTable, labels: ReportLabels) {
  const width = table.columns.length + 2
  const header = ws.getRow(TABLE_HEADER_ROW)
  expect(Array.from({ length: width }, (_, i) => header.getCell(i + 1).value)).toEqual([
    labels.rowHeader, ...table.columns, 'Total',
  ])

  const bodyRows = [...table.groups, { ...table.totals, label: labels.totalRowLabel }]
  bodyRows.forEach((g, i) => {
    const r = ws.getRow(TABLE_HEADER_ROW + 1 + i)
    expect(r.getCell(1).value).toBe(g.label)
    g.cells.forEach((v, j) => {
      const cell = r.getCell(j + 2)
      // null (PDF em-dash) <-> empty cell; numbers stay real numbers.
      expect(cell.value).toBe(v)
      expect(cell.type).toBe(v == null ? ExcelJS.ValueType.Null : ExcelJS.ValueType.Number)
    })
    expect(r.getCell(width).value).toBe(g.total)
    expect(r.getCell(width).type).toBe(ExcelJS.ValueType.Number)
  })

  // Nothing stray below the totals row.
  expect(ws.rowCount).toBe(TABLE_HEADER_ROW + bodyRows.length)
}

describe('buildClientMonthlyReportXlsx', () => {
  it('produces an Included and an Extras sheet', async () => {
    const wb = await load(KWN, KWN_LABELS)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Included', 'Extras'])
  })

  it('writes the statement header block above each table', async () => {
    const wb = await load(VV_NO_STOPS, VV_LABELS)
    for (const [name, title] of [['Included', 'Included Collections'], ['Extras', 'Verge Valet Extra']]) {
      const ws = sheet(wb, name!)
      expect(ws.getCell('A1').value).toBe(title)
      expect(ws.getCell('B2').value).toBe('Verge Valet')
      expect(ws.getCell('B3').value).toBe('Western Metropolitan Regional Council')
      expect(ws.getCell('B4').value).toBe('September 2026')
      expect(ws.getCell('B5').value).toBe('VV-2026-09')
      expect(ws.getCell('B6').value).toBe('05/10/2026')
    }
  })

  it.each([
    ['VV without stop data', VV_NO_STOPS, VV_LABELS],
    ['VV with crew-logged mattresses', VV_WITH_STOPS, VV_LABELS],
    ['KWN by area', KWN, KWN_LABELS],
    ['an empty month', EMPTY_MONTH, KWN_LABELS],
  ] as const)('every number ties out to the PDF model (%s)', async (_name, report, labels) => {
    const wb = await load(report, labels)
    expectTiesOut(sheet(wb, 'Included'), report.included, labels)
    expectTiesOut(sheet(wb, 'Extras'), report.extras, labels)
  })

  it('leaves the no-data Mattress column empty — not 0, not an em-dash', async () => {
    const wb = await load(VV_NO_STOPS, VV_LABELS)
    const ws = sheet(wb, 'Included')
    const col = VV_NO_STOPS.included.columns.indexOf('Mattress') + 2
    expect(col).toBeGreaterThan(1)
    for (let r = TABLE_HEADER_ROW + 1; r <= ws.rowCount; r++) {
      expect(ws.getRow(r).getCell(col).value).toBeNull()
    }
  })

  it('totals row equals a SUM of the column above it (what an invoice clerk would check)', async () => {
    const wb = await load(KWN, KWN_LABELS)
    const ws = sheet(wb, 'Included')
    const groups = KWN.included.groups.length
    const totalsRow = ws.getRow(TABLE_HEADER_ROW + 1 + groups)
    for (let c = 2; c <= KWN.included.columns.length + 2; c++) {
      let sum = 0
      for (let r = TABLE_HEADER_ROW + 1; r <= TABLE_HEADER_ROW + groups; r++) {
        sum += Number(ws.getRow(r).getCell(c).value ?? 0)
      }
      expect(totalsRow.getCell(c).value).toBe(sum)
    }
  })

  it('freezes the panes at the table header and fills it with the client primary colour', async () => {
    const wb = await load(KWN, KWN_LABELS)
    const ws = sheet(wb, 'Included')
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: TABLE_HEADER_ROW })
    const fill = ws.getRow(TABLE_HEADER_ROW).getCell(1).fill as ExcelJS.FillPattern
    expect(fill.fgColor?.argb).toBe('FF0D295A')
    expect(ws.getRow(TABLE_HEADER_ROW).getCell(1).font?.bold).toBe(true)
    expect(ws.getRow(ws.rowCount).getCell(1).font?.bold).toBe(true)
  })
})
