import { awstDateFromUtc } from '@/lib/booking/schedule-transition'

/**
 * Standard report periods (VER-297) — the six presets Dan specified for
 * /admin/reports (This week · Last week · This month · Last month · This FY ·
 * Last FY) plus a Custom escape hatch.
 *
 * Pure + deterministic: callers pass `nowUtc` and the financial_year rows; no
 * wall-clock or network reads here. All boundaries are AWST calendar dates
 * (UTC+8, no DST) computed via `awstDateFromUtc` + date-string arithmetic —
 * NEVER `Date#setHours()` (runtime-TZ trap, CLAUDE.md §21). Weeks run Mon–Sun.
 *
 * Period semantics are per-card and documented at each query site: changing
 * the period changes WHICH rows are counted, never HOW a metric is measured
 * (definitions doc v1.0 §"Standard periods").
 *
 * `kind` lets FY-anchored metrics (Service Delivery / BC — bookings carry a
 * service `fy_id`, and a booking can be CREATED before its service FY starts,
 * e.g. June bookings for July collections) scope by `fyId` on FY presets and
 * by date bounds on sub-FY presets.
 */

export const PERIOD_PRESETS = [
  'this-week',
  'last-week',
  'this-month',
  'last-month',
  'this-fy',
  'last-fy',
  'custom',
] as const

export type PeriodPreset = (typeof PERIOD_PRESETS)[number]

export interface PeriodFyRow {
  id: string
  label: string
  /** `YYYY-MM-DD` (AWST calendar dates in the DB). */
  start_date: string
  end_date: string
  is_current: boolean
}

export interface PeriodRange {
  /** Inclusive `YYYY-MM-DD` bounds; null = unbounded on that side. */
  from: string | null
  to: string | null
  /** 'fy' presets scope FY-anchored metrics by fyId; 'range' by date bounds. */
  kind: 'fy' | 'range'
  /** The FY the period belongs to (FY presets: that FY; otherwise current). */
  fyId: string | null
  /** Short human label for card provenance footers, e.g. "This month". */
  label: string
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Day-of-week for a YYYY-MM-DD, 0 = Monday … 6 = Sunday. TZ-safe (UTC math). */
function mondayIndexedDow(dateIso: string): number {
  const [y, m, d] = dateIso.split('-').map(Number)
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() // 0 = Sunday
  return (dow + 6) % 7
}

/** Add days to a YYYY-MM-DD via UTC math (no local-TZ involvement). */
function addDays(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split('-').map(Number)
  const t = new Date(Date.UTC(y!, m! - 1, d! + days))
  return t.toISOString().slice(0, 10)
}

function monthStart(dateIso: string): string {
  return `${dateIso.slice(0, 7)}-01`
}

function monthEnd(dateIso: string): string {
  const [y, m] = dateIso.split('-').map(Number)
  // Day 0 of the next month = last day of this month.
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10)
}

function currentFy(fyRows: readonly PeriodFyRow[]): PeriodFyRow | null {
  return fyRows.find((r) => r.is_current) ?? null
}

/** The FY immediately before the current one (latest end_date < current start). */
function lastFy(fyRows: readonly PeriodFyRow[]): PeriodFyRow | null {
  const cur = currentFy(fyRows)
  if (!cur) return null
  const prior = fyRows
    .filter((r) => r.end_date < cur.start_date)
    .sort((a, b) => (a.end_date < b.end_date ? 1 : -1))
  return prior[0] ?? null
}

export interface CustomRange {
  from?: string
  to?: string
}

/**
 * Resolves a preset to concrete AWST bounds. Custom bounds with malformed
 * dates are dropped (unbounded on that side). A missing FY row (no is_current,
 * or no prior FY) yields null bounds + kind 'fy' with fyId null — cards render
 * their empty state rather than silently widening to all-time.
 */
export function resolvePeriod(
  preset: PeriodPreset,
  nowUtc: Date,
  fyRows: readonly PeriodFyRow[],
  custom: CustomRange = {},
): PeriodRange {
  const today = awstDateFromUtc(nowUtc)
  const cur = currentFy(fyRows)

  switch (preset) {
    case 'this-week': {
      const from = addDays(today, -mondayIndexedDow(today))
      return { from, to: addDays(from, 6), kind: 'range', fyId: cur?.id ?? null, label: 'This week' }
    }
    case 'last-week': {
      const thisMon = addDays(today, -mondayIndexedDow(today))
      const from = addDays(thisMon, -7)
      return { from, to: addDays(from, 6), kind: 'range', fyId: cur?.id ?? null, label: 'Last week' }
    }
    case 'this-month':
      return {
        from: monthStart(today),
        to: monthEnd(today),
        kind: 'range',
        fyId: cur?.id ?? null,
        label: 'This month',
      }
    case 'last-month': {
      const lastMonthDay = addDays(monthStart(today), -1)
      return {
        from: monthStart(lastMonthDay),
        to: monthEnd(lastMonthDay),
        kind: 'range',
        fyId: cur?.id ?? null,
        label: 'Last month',
      }
    }
    case 'this-fy':
      return {
        from: cur?.start_date ?? null,
        to: cur?.end_date ?? null,
        kind: 'fy',
        fyId: cur?.id ?? null,
        label: cur ? `This FY (${cur.label})` : 'This FY',
      }
    case 'last-fy': {
      const prior = lastFy(fyRows)
      return {
        from: prior?.start_date ?? null,
        to: prior?.end_date ?? null,
        kind: 'fy',
        fyId: prior?.id ?? null,
        label: prior ? `Last FY (${prior.label})` : 'Last FY',
      }
    }
    case 'custom': {
      const from = custom.from !== undefined && DATE_RE.test(custom.from) ? custom.from : null
      const to = custom.to !== undefined && DATE_RE.test(custom.to) ? custom.to : null
      return { from, to, kind: 'range', fyId: cur?.id ?? null, label: 'Custom' }
    }
  }
}

/** `p_from` for the rolling last-12-months trendline: 1st of the month 11 months back. */
export function rolling12From(nowUtc: Date): string {
  const today = awstDateFromUtc(nowUtc)
  const [y, m] = today.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1 - 11, 1)).toISOString().slice(0, 10)
}
