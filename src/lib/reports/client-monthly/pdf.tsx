import path from 'node:path'
import { Document, Page, View, Text, Font, StyleSheet } from '@react-pdf/renderer'
import { DmLogo } from './dm-logo'
import type { ClientMonthlyReport, ReportGroupRow } from './report-model'

const fontDir = path.join(process.cwd(), 'public', 'report-fonts')
Font.register({
  family: 'Poppins',
  fonts: [{ src: path.join(fontDir, 'Poppins-SemiBold.ttf'), fontWeight: 600 }],
})
Font.register({
  family: 'DM Sans',
  fonts: [
    { src: path.join(fontDir, 'DMSans-Regular.ttf'), fontWeight: 400 },
    { src: path.join(fontDir, 'DMSans-Bold.ttf'), fontWeight: 700 },
  ],
})

export interface PdfProps {
  report: ClientMonthlyReport
  monthLabel: string
  refCode: string
  issuedLabel: string
  serviceName: string
  legalName: string
  extrasLabel: string
  rowHeader: string
  totalRowLabel: string
  primaryColour: string
  accentColour: string
}

/**
 * #rrggbb + alpha -> rgba() for tinted backgrounds. 6-digit #rrggbb only —
 * DB writes are zod-gated to that shape and the route caller null-coalesces;
 * not defensive by design.
 */
function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

const fmt = (v: number | null) => (v == null ? '—' : v.toLocaleString('en-AU'))
const isMuted = (v: number | null) => v == null || v === 0

const ROWTOTAL_TEXT = '#33531f'

const styles = StyleSheet.create({
  page: {
    fontFamily: 'DM Sans',
    fontSize: 9.5,
    color: '#1a1a1a',
    backgroundColor: '#ffffff',
  },
  band: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: '7mm',
    paddingHorizontal: '14mm',
  },
  bandLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  bandTitleBlock: {
    marginLeft: '7mm',
  },
  bandTitle: {
    fontFamily: 'Poppins',
    fontWeight: 600,
    fontSize: 14.5,
    color: '#ffffff',
    lineHeight: 1.25,
  },
  bandSubtitle: {
    fontSize: 9.5,
    color: '#b9c6da',
    marginTop: 1.5,
  },
  bandRight: {
    alignItems: 'flex-end',
  },
  bandMonth: {
    fontFamily: 'Poppins',
    fontWeight: 600,
    fontSize: 13,
    color: '#ffffff',
  },
  content: {
    flexGrow: 1,
    paddingTop: '7mm',
    paddingHorizontal: '14mm',
  },
  pill: {
    alignSelf: 'flex-start',
    fontFamily: 'Poppins',
    fontWeight: 600,
    fontSize: 9,
    color: '#ffffff',
    borderRadius: 3,
    paddingVertical: 3.5,
    paddingHorizontal: 8,
    marginBottom: 6,
  },
  pillSpaced: {
    marginTop: '6mm',
  },
  table: {
    width: '100%',
  },
  headerRow: {
    flexDirection: 'row',
    backgroundColor: '#f1f4f9',
    borderBottomWidth: 2,
  },
  headerCell: {
    flex: 1,
    fontSize: 7.3,
    fontWeight: 700,
    color: '#334155',
    letterSpacing: 0.3,
    paddingVertical: 4.5,
    paddingHorizontal: 4,
    textAlign: 'right',
  },
  headerCellFirst: {
    flex: 2.2,
    fontSize: 7.3,
    fontWeight: 700,
    color: '#334155',
    letterSpacing: 0.3,
    paddingVertical: 4.5,
    paddingHorizontal: 4,
    textAlign: 'left',
  },
  headerCellTotal: {
    flex: 1,
    fontSize: 7.3,
    fontWeight: 700,
    letterSpacing: 0.3,
    paddingVertical: 4.5,
    paddingHorizontal: 4,
    textAlign: 'right',
    backgroundColor: '#eef4ea',
    color: ROWTOTAL_TEXT,
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e8ecf2',
  },
  rowEven: {
    backgroundColor: '#fafbfd',
  },
  cell: {
    flex: 1,
    fontSize: 9.5,
    paddingVertical: 4.5,
    paddingHorizontal: 5,
    textAlign: 'right',
  },
  cellFirst: {
    flex: 2.2,
    fontSize: 9.5,
    paddingVertical: 4.5,
    paddingHorizontal: 5,
    textAlign: 'left',
  },
  cellMuted: {
    color: '#c2cad6',
  },
  cellTotal: {
    flex: 1,
    fontSize: 9.5,
    fontWeight: 700,
    paddingVertical: 4.5,
    paddingHorizontal: 5,
    textAlign: 'right',
    color: ROWTOTAL_TEXT,
  },
  totalRow: {
    flexDirection: 'row',
  },
  totalText: {
    color: '#ffffff',
    fontWeight: 700,
  },
  grandTotalCell: {
    fontSize: 10.5,
    color: '#ffffff',
    fontWeight: 700,
  },
  foot: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#f1f4f9',
    paddingVertical: 5,
    paddingHorizontal: '14mm',
    fontSize: 8,
    color: '#64748b',
  },
})

function Table({
  columns,
  groups,
  totals,
  rowHeader,
  totalRowLabel,
  primaryColour,
  accentColour,
}: {
  columns: string[]
  groups: ReportGroupRow[]
  totals: ReportGroupRow
  rowHeader: string
  totalRowLabel: string
  primaryColour: string
  accentColour: string
}) {
  const rowTotalBg = tint(accentColour, 0.14)
  return (
    <View style={styles.table}>
      <View style={[styles.headerRow, { borderBottomColor: primaryColour }]}>
        <Text style={styles.headerCellFirst}>{rowHeader.toUpperCase()}</Text>
        {columns.map((c) => (
          <Text key={c} style={styles.headerCell}>
            {c.toUpperCase()}
          </Text>
        ))}
        <Text style={styles.headerCellTotal}>TOTAL</Text>
      </View>

      {groups.map((g, i) => (
        <View key={g.label} style={[styles.row, i % 2 === 1 ? styles.rowEven : {}]}>
          <Text style={styles.cellFirst}>{g.label}</Text>
          {g.cells.map((v, j) => (
            <Text key={j} style={[styles.cell, isMuted(v) ? styles.cellMuted : {}]}>
              {fmt(v)}
            </Text>
          ))}
          <Text style={[styles.cellTotal, { backgroundColor: rowTotalBg }]}>{fmt(g.total)}</Text>
        </View>
      ))}

      <View style={[styles.totalRow, { backgroundColor: primaryColour }]}>
        <Text style={[styles.cellFirst, styles.totalText]}>{totalRowLabel}</Text>
        {totals.cells.map((v, j) => (
          <Text key={j} style={[styles.cell, styles.totalText]}>
            {fmt(v)}
          </Text>
        ))}
        <Text style={[styles.cellTotal, styles.grandTotalCell, { backgroundColor: accentColour }]}>
          {fmt(totals.total)}
        </Text>
      </View>
    </View>
  )
}

export function ClientMonthlyReportPdf(props: PdfProps) {
  const {
    report,
    monthLabel,
    refCode,
    issuedLabel,
    serviceName,
    legalName,
    extrasLabel,
    rowHeader,
    totalRowLabel,
    primaryColour,
    accentColour,
  } = props

  return (
    <Document>
      <Page size="A4" orientation="landscape" style={styles.page}>
        <View style={[styles.band, { backgroundColor: primaryColour }]}>
          <View style={styles.bandLeft}>
            <DmLogo width={100} />
            <View style={styles.bandTitleBlock}>
              <Text style={styles.bandTitle}>Monthly Collections Statement</Text>
              <Text style={styles.bandSubtitle}>{serviceName} · Bulk Verge Collection Service</Text>
            </View>
          </View>
          <View style={styles.bandRight}>
            <Text style={styles.bandMonth}>{monthLabel}</Text>
            <Text style={styles.bandSubtitle}>
              Ref {refCode} · Issued {issuedLabel}
            </Text>
          </View>
        </View>

        <View style={styles.content}>
          <Text style={[styles.pill, { backgroundColor: primaryColour }]}>Included Collections</Text>
          <Table
            columns={report.included.columns}
            groups={report.included.groups}
            totals={report.included.totals}
            rowHeader={rowHeader}
            totalRowLabel={totalRowLabel}
            primaryColour={primaryColour}
            accentColour={accentColour}
          />

          <Text style={[styles.pill, styles.pillSpaced, { backgroundColor: accentColour }]}>{extrasLabel}</Text>
          <Table
            columns={report.extras.columns}
            groups={report.extras.groups}
            totals={report.extras.totals}
            rowHeader={rowHeader}
            totalRowLabel={totalRowLabel}
            primaryColour={primaryColour}
            accentColour={accentColour}
          />
        </View>

        <View style={styles.foot} fixed>
          <Text>
            Prepared for the <Text style={{ fontWeight: 700, color: primaryColour }}>{legalName}</Text> by{' '}
            <Text style={{ fontWeight: 700, color: primaryColour }}>D&M Waste Management</Text>
          </Text>
          <Text
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  )
}
