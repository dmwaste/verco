import { awstDateFromUtc } from '@/lib/booking/schedule-transition'
import { workingDaysBetween } from '@/lib/reports/working-days'

/**
 * SR — Service Ticket SLA (VER-179, spec §3.4).
 *
 * Two independent sub-SLAs computed on one card, both pure + deterministic
 * (no Supabase, no network, no wall-clock reads — every window compares two
 * stored timestamps passed in by the caller):
 *
 *   - First response: created_at → first_response_at within RESPONSE_TARGET_WD
 *     (3) WORKING days. Reuses the shared `workingDaysBetween` helper (WA-holiday
 *     aware), shared with RECT. Inert until FRSTAMP populates first_response_at
 *     in prod — when no ticket has a first-response timestamp the sub-metric is
 *     `isEmpty`.
 *   - Resolution: created_at → COALESCE(resolved_at, closed_at) within
 *     RESOLUTION_TARGET_DAYS (30) CALENDAR days (§8 #12: resolution is calendar,
 *     not working, days). Maps to the WMRC contract "close out system requests
 *     < 30 days" KPI.
 *
 * Sample-size gating per the spec's empty / low-`n` / at-`n` strategy:
 *   - `n === 0`            → isEmpty, pct null (no data for this sub-metric yet)
 *   - `0 < n < LOW_N`      → isLowN, raw fraction reported (renderer suppresses
 *                            the % headline + colour)
 *   - `n >= LOW_N`         → at-n, % is the headline
 *
 * Input shape mirrors the Phase-3 consumer fold (`reports-client.tsx`): each
 * ticket carries `createdAtAwst` + `firstResponseAtAwst` as bare AWST
 * `YYYY-MM-DD` dates (the fold runs `awstDateFromUtc`), and `resolvedAtUtc` as
 * the raw UTC timestamp from `COALESCE(resolved_at, closed_at)` (or null).
 */

/** First-response SLA window, in WA working days. */
export const RESPONSE_TARGET_WD = 3
/** Resolution SLA window, in calendar days (WMRC contract). */
export const RESOLUTION_TARGET_DAYS = 30
/** Minimum sample size before a sub-metric % is treated as meaningful. */
export const SERVICE_TICKET_SLA_LOW_N = 5

/** One service ticket, pre-folded by the consumer (timestamps already AWST/UTC as noted). */
export interface ServiceTicketRow {
  /** created_at as a bare AWST date (YYYY-MM-DD). */
  createdAtAwst: string
  /** first_response_at as a bare AWST date, or null when never responded (FRSTAMP). */
  firstResponseAtAwst: string | null
  /** COALESCE(resolved_at, closed_at) as a raw UTC timestamp, or null when unresolved. */
  resolvedAtUtc: string | null
}

/** Per-sub-SLA result. `pct` is null when `n === 0`. */
export interface ServiceTicketSubMetric {
  /** Tickets carrying the relevant timestamp (the denominator). */
  n: number
  /** Of `n`, how many met the SLA window. */
  withinTarget: number
  /** withinTarget / n × 100, or null when n === 0. */
  pct: number | null
  /** n === 0. */
  isEmpty: boolean
  /** 0 < n < LOW_N. */
  isLowN: boolean
}

export interface ServiceTicketSlaResult {
  responded: ServiceTicketSubMetric
  resolved: ServiceTicketSubMetric
}

export interface ServiceTicketSlaInput {
  tickets: ServiceTicketRow[]
  /** WA public-holiday dates (YYYY-MM-DD) for the working-day response window. */
  waHolidays: Iterable<string>
}

/**
 * Computes the two service-ticket sub-SLAs. Pure + deterministic.
 */
export function computeServiceTicketSla({
  tickets,
  waHolidays,
}: ServiceTicketSlaInput): ServiceTicketSlaResult {
  const holidaySet = waHolidays instanceof Set ? waHolidays : new Set(waHolidays)

  let respondedN = 0
  let respondedWithin = 0
  let resolvedN = 0
  let resolvedWithin = 0

  for (const t of tickets) {
    // First-response sub-SLA: only tickets with a first_response_at count.
    if (t.firstResponseAtAwst != null) {
      respondedN += 1
      // Guard unparseable dates BEFORE calling workingDaysBetween — that helper
      // routes through awstDateFromUtc which throws on an invalid Date. A
      // malformed row therefore yields no within-target credit (n still counts).
      if (isParseableDate(t.createdAtAwst) && isParseableDate(t.firstResponseAtAwst)) {
        const wd = workingDaysBetween(t.createdAtAwst, t.firstResponseAtAwst, holidaySet)
        // A same-day or weekend-only response is 0 working days → within target.
        if (wd <= RESPONSE_TARGET_WD) respondedWithin += 1
      }
    }

    // Resolution sub-SLA: only tickets with a resolution timestamp count.
    if (t.resolvedAtUtc != null) {
      resolvedN += 1
      const days = calendarDaysBetween(t.createdAtAwst, t.resolvedAtUtc)
      if (days != null && days <= RESOLUTION_TARGET_DAYS) resolvedWithin += 1
    }
  }

  return {
    responded: subMetric(respondedN, respondedWithin),
    resolved: subMetric(resolvedN, resolvedWithin),
  }
}

/** True when the ISO string parses to a real instant (guards awstDateFromUtc, which throws on NaN). */
function isParseableDate(iso: string): boolean {
  return !Number.isNaN(new Date(iso).getTime())
}

/** Builds a sub-metric result with pct + empty/low-n gating. */
function subMetric(n: number, withinTarget: number): ServiceTicketSubMetric {
  return {
    n,
    withinTarget,
    pct: n === 0 ? null : (withinTarget / n) * 100,
    isEmpty: n === 0,
    isLowN: n > 0 && n < SERVICE_TICKET_SLA_LOW_N,
  }
}

/**
 * Whole calendar days between a bare AWST start date and the AWST calendar date
 * of a UTC resolution timestamp. Returns null on any unparseable input so the
 * caller never credits a malformed row as within target.
 *
 * The resolution window is calendar (not working) days per §8 #12 — weekends and
 * holidays do NOT extend it.
 */
function calendarDaysBetween(startAwst: string, endUtcIso: string): number | null {
  const endDate = new Date(endUtcIso)
  if (Number.isNaN(endDate.getTime())) return null
  const endAwst = awstDateFromUtc(endDate)

  const startMs = Date.parse(`${startAwst}T00:00:00Z`)
  const endMs = Date.parse(`${endAwst}T00:00:00Z`)
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null

  return Math.round((endMs - startMs) / 86_400_000)
}
