import { describe, it, expect } from 'vitest'
import {
  buildClientMonthlyReport,
  shortenAreaLabel,
  type ReportRow,
  type OfferedService,
} from '@/lib/reports/client-monthly/report-model'

const KWN_OFFERED: OfferedService[] = [
  { name: 'Bulk Waste', category: 'bulk' },
  { name: 'Green Waste', category: 'bulk' },
  { name: 'E-Waste', category: 'anc' },
  { name: 'Mattress', category: 'anc' },
  { name: 'Whitegoods', category: 'anc' },
]

const booked = (over: Partial<ReportRow>): ReportRow => ({
  source: 'booked', group_key: 'g1', group_label: 'Kwinana Area 1',
  service_name: 'Bulk Waste', is_mattress: false, is_extra: false, units: 1,
  ...over,
})

describe('shortenAreaLabel', () => {
  it('shortens "Kwinana Area 1" to "Area 1"', () => {
    expect(shortenAreaLabel('Kwinana Area 1')).toBe('Area 1')
  })
  it('falls back to the full name when no Area-N suffix', () => {
    expect(shortenAreaLabel('Town Centre North')).toBe('Town Centre North')
  })
})

describe('buildClientMonthlyReport', () => {
  it('pivots included rows with row and column totals', () => {
    const rows: ReportRow[] = [
      booked({ units: 130 }),
      booked({ service_name: 'Green Waste', units: 105 }),
      booked({ group_key: 'g2', group_label: 'Kwinana Area 2', units: 152 }),
    ]
    const r = buildClientMonthlyReport({
      rows, offered: KWN_OFFERED, grouping: 'area', mattressCloseoutStream: null,
    })
    expect(r.included.groups.map((g) => g.label)).toEqual(['Area 1', 'Area 2'])
    const a1 = r.included.groups[0]!
    expect(a1.cells[0]).toBe(130)   // Bulk Waste
    expect(a1.cells[1]).toBe(105)   // Green Waste
    expect(a1.total).toBe(235)
    expect(r.included.totals.cells[0]).toBe(282)
    expect(r.included.totals.total).toBe(387)
  })

  it('orders columns bulk-category first, then ancillary alphabetical, ID last', () => {
    const rows: ReportRow[] = [
      booked({ service_name: 'Illegal Dumping', units: 1 }),
      booked({ service_name: 'Whitegoods', units: 2 }),
    ]
    const r = buildClientMonthlyReport({
      rows, offered: KWN_OFFERED, grouping: 'area', mattressCloseoutStream: null,
    })
    expect(r.included.columns).toEqual([
      'Bulk Waste', 'Green Waste', 'E-Waste', 'Mattress', 'Whitegoods', 'Illegal Dumping',
    ])
  })

  it('splits extras into their own table and never gives extras an ID column', () => {
    const rows: ReportRow[] = [
      booked({ units: 10 }),
      booked({ is_extra: true, units: 1 }),
      booked({ service_name: 'Illegal Dumping', units: 3 }),
    ]
    const r = buildClientMonthlyReport({
      rows, offered: KWN_OFFERED, grouping: 'area', mattressCloseoutStream: null,
    })
    expect(r.included.totals.total).toBe(13)
    expect(r.extras.totals.total).toBe(1)
    expect(r.extras.columns).not.toContain('Illegal Dumping')
    expect(r.extras.columns).toEqual(['Bulk Waste', 'Green Waste', 'E-Waste', 'Mattress', 'Whitegoods'])
  })

  it('excludes an ID service from extras by category even when its display name is not the literal "Illegal Dumping"', () => {
    const offered: OfferedService[] = [
      ...KWN_OFFERED,
      { name: 'Illegal Dump Collection', category: 'id' },
    ]
    const rows: ReportRow[] = [
      booked({ units: 10 }),
      booked({ service_name: 'Illegal Dump Collection', is_extra: true, units: 5 }),
    ]
    const r = buildClientMonthlyReport({
      rows, offered, grouping: 'area', mattressCloseoutStream: null,
    })
    expect(r.extras.columns).not.toContain('Illegal Dump Collection')
    expect(r.extras.totals.total).toBe(0)
  })

  it('renders em-dash (null) mattress cells when closeout stream set but no stop data', () => {
    const rows: ReportRow[] = [booked({ group_label: 'Town of Cottesloe', units: 114 })]
    const r = buildClientMonthlyReport({
      rows, offered: [{ name: 'Bulk Waste', category: 'bulk' }, { name: 'Green Waste', category: 'bulk' }],
      grouping: 'sub_client', mattressCloseoutStream: 'general',
    })
    const mi = r.included.columns.indexOf('Mattress')
    expect(mi).toBeGreaterThan(-1)
    expect(r.included.groups[0]!.cells[mi]).toBeNull()
    expect(r.included.totals.cells[mi]).toBeNull()
    // null cells don't poison row totals
    expect(r.included.groups[0]!.total).toBe(114)
  })

  it('uses real numbers (0 for missing groups) once any stop_mattress data exists', () => {
    const rows: ReportRow[] = [
      booked({ group_key: 'c1', group_label: 'Town of Cottesloe', units: 114 }),
      booked({ group_key: 'c2', group_label: 'Town of Mosman Park', units: 151 }),
      { source: 'stop_mattress', group_key: 'c1', group_label: 'Town of Cottesloe',
        service_name: 'Mattress', is_mattress: true, is_extra: false, units: 4 },
    ]
    const r = buildClientMonthlyReport({
      rows, offered: [{ name: 'Bulk Waste', category: 'bulk' }],
      grouping: 'sub_client', mattressCloseoutStream: 'general',
    })
    const mi = r.included.columns.indexOf('Mattress')
    expect(r.included.groups.find((g) => g.label === 'Town of Cottesloe')!.cells[mi]).toBe(4)
    expect(r.included.groups.find((g) => g.label === 'Town of Mosman Park')!.cells[mi]).toBe(0)
    expect(r.included.totals.cells[mi]).toBe(4)
  })

  it('a zero-extras month still renders the full extras table structure', () => {
    const rows: ReportRow[] = [booked({ units: 10 })]
    const r = buildClientMonthlyReport({
      rows, offered: KWN_OFFERED, grouping: 'area', mattressCloseoutStream: null,
    })
    expect(r.extras.columns.length).toBeGreaterThan(0)
    expect(r.extras.groups.map((g) => g.total)).toEqual([0])
    expect(r.extras.totals.total).toBe(0)
  })

  it('sorts groups alphabetically by label', () => {
    const rows: ReportRow[] = [
      booked({ group_key: 'm', group_label: 'Town of Mosman Park' }),
      booked({ group_key: 'p', group_label: 'Shire of Peppermint Grove' }),
    ]
    const r = buildClientMonthlyReport({
      rows, offered: [{ name: 'Bulk Waste', category: 'bulk' }],
      grouping: 'sub_client', mattressCloseoutStream: null,
    })
    expect(r.included.groups.map((g) => g.label)).toEqual([
      'Shire of Peppermint Grove', 'Town of Mosman Park',
    ])
  })

  it('falls back to full raw labels when two distinct groups shorten to the same display label', () => {
    const rows: ReportRow[] = [
      booked({ group_key: 'g1', group_label: 'North Area 1', units: 1 }),
      booked({ group_key: 'g2', group_label: 'South Area 1', units: 1 }),
    ]
    const r = buildClientMonthlyReport({
      rows, offered: [{ name: 'Bulk Waste', category: 'bulk' }],
      grouping: 'area', mattressCloseoutStream: null,
    })
    expect(r.included.groups.map((g) => g.label)).toEqual([
      'North Area 1', 'South Area 1',
    ])
  })

  it('still shortens labels in the non-colliding case', () => {
    const rows: ReportRow[] = [
      booked({ group_key: 'g1', group_label: 'Kwinana Area 1', units: 1 }),
      booked({ group_key: 'g2', group_label: 'Kwinana Area 2', units: 1 }),
    ]
    const r = buildClientMonthlyReport({
      rows, offered: [{ name: 'Bulk Waste', category: 'bulk' }],
      grouping: 'area', mattressCloseoutStream: null,
    })
    expect(r.included.groups.map((g) => g.label)).toEqual(['Area 1', 'Area 2'])
  })

  it('groups a null group_key into a single Unassigned row without crashing', () => {
    const rows: ReportRow[] = [
      booked({ group_key: null as unknown as string, group_label: 'Unassigned', units: 3 }),
      booked({ group_key: null as unknown as string, group_label: 'Unassigned', service_name: 'Green Waste', units: 2 }),
    ]
    const r = buildClientMonthlyReport({
      rows, offered: KWN_OFFERED, grouping: 'sub_client', mattressCloseoutStream: null,
    })
    expect(r.included.groups).toHaveLength(1)
    expect(r.included.groups[0]!.label).toBe('Unassigned')
    expect(r.included.groups[0]!.total).toBe(5)
    expect(r.included.totals.total).toBe(5)
  })

  it('pins the ancillary-tier default for an unknown service not present in offered', () => {
    const rows: ReportRow[] = [
      booked({ service_name: 'Mystery Service', units: 1 }),
      booked({ service_name: 'Illegal Dumping', units: 2 }),
    ]
    const r = buildClientMonthlyReport({
      rows, offered: KWN_OFFERED, grouping: 'area', mattressCloseoutStream: null,
    })
    expect(r.included.columns).toEqual([
      'Bulk Waste', 'Green Waste', 'E-Waste', 'Mattress', 'Mystery Service', 'Whitegoods', 'Illegal Dumping',
    ])
  })
})
