/**
 * Pure pivot logic for the monthly client report PDF (invoice-backing).
 * Spec: docs/superpowers/specs/2026-08-06-monthly-client-reports-design.md
 * No Supabase, no wall clock — deterministic and fully unit-tested (money-
 * adjacent: these numbers back the council invoice).
 *
 * Input rows come from the get_client_monthly_report RPC in long format:
 * `booked` rows are booking_item units; `stop_mattress` rows are crew-logged
 * mattress counts (VV-style tenants). The mattress column renders an em-dash
 * (null) when the tenant logs mattresses at closeout but NO stop data exists
 * for the month — a fake 0 would misstate the count; once any stop data
 * exists, absent groups are real zeros.
 *
 * group_key can be null-ish for sub-client tenants with unassigned areas
 * (single 'Unassigned' bucket) — keys are treated as opaque strings.
 */

export interface ReportRow {
  source: 'booked' | 'stop_mattress'
  group_key: string
  group_label: string
  service_name: string
  is_mattress: boolean
  is_extra: boolean
  units: number
}

export interface OfferedService {
  name: string
  category: 'bulk' | 'anc' | 'id'
}

export interface ReportGroupRow {
  label: string
  /** One entry per column; null = no data (render em-dash), never fake 0. */
  cells: (number | null)[]
  total: number
}

export interface ReportTable {
  columns: string[]
  groups: ReportGroupRow[]
  totals: ReportGroupRow
}

export interface ClientMonthlyReport {
  included: ReportTable
  extras: ReportTable
}

export interface BuildOptions {
  rows: ReportRow[]
  offered: OfferedService[]
  grouping: 'area' | 'sub_client'
  mattressCloseoutStream: string | null
}

const ID_NAME = 'Illegal Dumping'
const MATTRESS_NAME = 'Mattress'

/** "Kwinana Area 1" -> "Area 1"; anything without an Area-N suffix passes through. */
export function shortenAreaLabel(name: string): string {
  const m = name.match(/\b(Area \d+)$/)
  return m?.[1] ?? name
}

/** bulk services first (alphabetical), then ancillary alphabetical, ID always last. */
function orderColumns(names: string[], offered: OfferedService[]): string[] {
  const cat = new Map(offered.map((s) => [s.name, s.category]))
  const rank = (n: string) =>
    n === ID_NAME || cat.get(n) === 'id' ? 2 : cat.get(n) === 'anc' ? 1 : cat.get(n) === 'bulk' ? 0 : 1
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

function pivot(
  columns: string[],
  groupLabels: Map<string, string>,
  cellValues: Map<string, Map<string, number>>, // group_key -> service -> units
  nullColumns: Set<string>
): ReportTable {
  const groups: ReportGroupRow[] = [...groupLabels.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([key, label]) => {
      const values = cellValues.get(key)
      const cells = columns.map((c) =>
        nullColumns.has(c) ? null : (values?.get(c) ?? 0)
      )
      return { label, cells, total: cells.reduce<number>((t, v) => t + (v ?? 0), 0) }
    })
  const totals: ReportGroupRow = {
    label: 'ALL',
    cells: columns.map((c, i) =>
      nullColumns.has(c) ? null : groups.reduce((t, g) => t + (g.cells[i] ?? 0), 0)
    ),
    total: groups.reduce((t, g) => t + g.total, 0),
  }
  return { columns, groups, totals }
}

export function buildClientMonthlyReport(opts: BuildOptions): ClientMonthlyReport {
  const { rows, offered, grouping, mattressCloseoutStream } = opts

  const labelOf = (raw: string) => (grouping === 'area' ? shortenAreaLabel(raw) : raw)

  const groupLabels = new Map<string, string>()
  for (const r of rows) groupLabels.set(r.group_key, labelOf(r.group_label))

  const hasStopData = rows.some((r) => r.source === 'stop_mattress')
  const mattressExpected = mattressCloseoutStream != null

  const add = (map: Map<string, Map<string, number>>, key: string, svc: string, units: number) => {
    const inner = map.get(key) ?? new Map<string, number>()
    inner.set(svc, (inner.get(svc) ?? 0) + units)
    map.set(key, inner)
  }

  // ---- included ----
  const includedCells = new Map<string, Map<string, number>>()
  for (const r of rows) {
    if (r.source === 'booked' && !r.is_extra) add(includedCells, r.group_key, r.service_name, r.units)
    if (r.source === 'stop_mattress') add(includedCells, r.group_key, MATTRESS_NAME, r.units)
  }
  const includedNames = new Set<string>(offered.map((s) => s.name))
  for (const r of rows) if (!r.is_extra) includedNames.add(r.service_name)
  if (mattressExpected) includedNames.add(MATTRESS_NAME)
  const includedNull = new Set<string>(
    mattressExpected && !hasStopData ? [MATTRESS_NAME] : []
  )
  const included = pivot(
    orderColumns([...includedNames], offered), groupLabels, includedCells, includedNull
  )

  // ---- extras (resident-paid; ID is never a resident-paid service) ----
  const extrasCells = new Map<string, Map<string, number>>()
  for (const r of rows) {
    if (r.source === 'booked' && r.is_extra) add(extrasCells, r.group_key, r.service_name, r.units)
  }
  const extrasNames = new Set<string>(
    offered.filter((s) => s.category !== 'id').map((s) => s.name)
  )
  for (const r of rows) if (r.is_extra) extrasNames.add(r.service_name)
  if (mattressExpected) extrasNames.add(MATTRESS_NAME)
  extrasNames.delete(ID_NAME)
  const extras = pivot(
    orderColumns([...extrasNames], offered), groupLabels, extrasCells, new Set()
  )

  return { included, extras }
}
