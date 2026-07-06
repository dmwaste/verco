import {
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  startOfMonth,
  startOfWeek,
} from 'date-fns'

// `current` is the resident's already-held date during an edit — it is always
// shown and pre-selected even when it has since closed, so it needs a neutral
// brand-tinted token rather than the red `closed` style (which would render the
// resident's own booking as an error). See edit-aware-dates.ts.
export type DateStatus = 'available' | 'low' | 'closed' | 'current'

export const STATUS_LABEL: Record<DateStatus, string> = {
  available: 'Available',
  low: 'Low Availability',
  closed: 'Closed',
  current: 'Current date',
}

// Chip/pill colours shared by the calendar cells and the selected-date summary.
export const STATUS_CHIP: Record<DateStatus, string> = {
  available:
    'border-[var(--brand-accent-dark)] bg-[var(--brand-accent-light)] text-[#006A38]',
  low: 'border-[#E2A23B] bg-[#FFF7E6] text-[#B7791F]',
  closed: 'border-[#E53E3E] bg-[#FFF0F0] text-[#E53E3E]',
  current: 'border-[var(--brand)] bg-[#E8EEF2] text-[var(--brand)]',
}

export const WEEKDAY_LABELS = [
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
  'Sun',
] as const

/**
 * Distinct months (as first-of-month dates) that contain at least one of the
 * given dates, ascending. Drives month navigation that skips empty months — so
 * prev/next only ever land on a month that actually has collection dates.
 */
export function uniqueMonths(dates: Date[]): Date[] {
  const seen = new Map<string, Date>()
  for (const d of dates) {
    const first = startOfMonth(d)
    const key = `${first.getFullYear()}-${first.getMonth()}`
    if (!seen.has(key)) seen.set(key, first)
  }
  return [...seen.values()].sort((a, b) => a.getTime() - b.getTime())
}

/**
 * The Monday-first day cells covering the calendar month that `month` falls in
 * (always whole weeks, so 35 or 42 days). Trailing/leading days from adjacent
 * months are included — use date-fns `isSameMonth` to fade them in the UI.
 */
export function monthGrid(month: Date): Date[] {
  const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 })
  const end = endOfWeek(endOfMonth(month), { weekStartsOn: 1 })
  return eachDayOfInterval({ start, end })
}
