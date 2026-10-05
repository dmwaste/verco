import ExcelJS from 'exceljs'
import type { ClientMonthlyReport, ReportGroupRow, ReportLabels, ReportTable } from './report-model'

/**
 * Excel rendering of the invoice-backing monthly collections statement — the
 * same ClientMonthlyReport the PDF renders, so the two can never disagree.
 * Office staff paste these numbers into invoices, so every quantity is a real
 * numeric cell (SUM works). A null cell (the PDF's em-dash, "no data") stays
 * EMPTY — never 0, never '—' — keeping the model's no-data ≠ zero rule.
 */

/** Rows 1–6 hold the statement header; the table header sits here, frozen. */
export const TABLE_HEADER_ROW = 8

const NUM_FMT = '#,##0'
const TOTALS_FILL = 'FFF1F4F9'

/** #rrggbb -> ExcelJS ARGB. 6-digit only — same contract as the PDF's tint(). */
const argb = (hex: string) => `FF${hex.replace('#', '').toUpperCase()}`

function writeRow(ws: ExcelJS.Worksheet, rowNumber: number, label: string, g: ReportGroupRow) {
  const row = ws.getRow(rowNumber)
  row.getCell(1).value = label
  g.cells.forEach((v, i) => {
    if (v == null) return
    const cell = row.getCell(i + 2)
    cell.value = v
    cell.numFmt = NUM_FMT
  })
  const total = row.getCell(g.cells.length + 2)
  total.value = g.total
  total.numFmt = NUM_FMT
  total.font = { bold: true }
  return row
}

function addTableSheet(
  wb: ExcelJS.Workbook,
  name: string,
  title: string,
  table: ReportTable,
  labels: ReportLabels
) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: TABLE_HEADER_ROW }] })
  const width = table.columns.length + 2

  ws.getCell('A1').value = title
  ws.getCell('A1').font = { bold: true, size: 14 }
  const meta: [string, string][] = [
    ['Service', labels.serviceName],
    ['Prepared for', labels.legalName],
    ['Month', labels.monthLabel],
    ['Ref', labels.refCode],
    ['Issued', labels.issuedLabel],
  ]
  meta.forEach(([key, value], i) => {
    const row = ws.getRow(i + 2)
    row.getCell(1).value = key
    row.getCell(1).font = { bold: true }
    row.getCell(2).value = value
  })

  const header = ws.getRow(TABLE_HEADER_ROW)
  ;[labels.rowHeader, ...table.columns, 'Total'].forEach((text, i) => {
    const cell = header.getCell(i + 1)
    cell.value = text
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(labels.primaryColour) } }
    cell.alignment = { horizontal: i === 0 ? 'left' : 'right', vertical: 'middle', wrapText: true }
  })

  table.groups.forEach((g, i) => writeRow(ws, TABLE_HEADER_ROW + 1 + i, g.label, g))

  const totals = writeRow(ws, TABLE_HEADER_ROW + 1 + table.groups.length, labels.totalRowLabel, table.totals)
  for (let c = 1; c <= width; c++) {
    const cell = totals.getCell(c)
    cell.font = { bold: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTALS_FILL } }
    cell.border = { top: { style: 'thin' } }
  }

  const labelWidth = Math.max(
    ...meta.map(([key]) => key.length),
    labels.rowHeader.length,
    labels.totalRowLabel.length,
    ...table.groups.map((g) => g.label.length)
  )
  ws.getColumn(1).width = Math.min(labelWidth + 2, 45)
  for (let c = 2; c <= width; c++) {
    const text = String(header.getCell(c).value ?? '')
    ws.getColumn(c).width = Math.min(Math.max(text.length + 2, 10), 18)
  }
}

export async function buildClientMonthlyReportXlsx(
  report: ClientMonthlyReport,
  labels: ReportLabels
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'D&M Waste Management'
  addTableSheet(wb, 'Included', 'Included Collections', report.included, labels)
  addTableSheet(wb, 'Extras', labels.extrasLabel, report.extras, labels)
  return Buffer.from(await wb.xlsx.writeBuffer())
}
