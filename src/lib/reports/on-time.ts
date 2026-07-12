import { awstDateFromUtc } from '@/lib/booking/schedule-transition'

/**
 * ONTIME — On-Time Collection (spec §3.2).
 *
 * A completed collection stop is on-time when the AWST calendar date of its
 * `completed_at` (a UTC instant) equals the scheduled `collection_date.date`
 * (already an AWST YYYY-MM-DD). The metric is the share of completed stops that
 * were on-time, over ALL completed stops (per-stop grain — a multi-stream
 * booking contributes up to two stop rows).
 *
 * Pure function: no Supabase, no network, no wall-clock reads. It compares two
 * stored timestamps passed in by the caller, so it is fully deterministic.
 *
 * CRITICAL TZ rule: `completed_at` is UTC, the scheduled date is AWST. The
 * comparison MUST go through `awstDateFromUtc` (UTC+8, no DST) — NEVER compare
 * the raw UTC date, or a 7:30am-AWST closeout (which is the previous UTC day)
 * mis-buckets as the wrong collection day.
 *
 * KPI INVARIANT (#390.2): `scheduledDate` MUST be the STOP's dispatched date
 * (`collection_stop.collection_date_id`), NEVER the booking's possibly-corrected
 * date. A #378 contractor date-override edits `booking_item.collection_date_id`
 * but deliberately leaves the stop as-dispatched — the stop is an immutable
 * record of what the crew was routed to do. Keying this contractual metric off
 * the corrected booking date would let a back-date launder a genuine wrong-day
 * miss into an on-time success (gaming the WMRC 98% target). Do not "fix" the
 * stop↔booking date divergence by repointing this to the booking date.
 */

/** WMRC contractual on-time target. */
export const ON_TIME_TARGET_PCT = 98

/**
 * Minimum number of completed stops before a coloured pass/fail percentage is
 * shown. Below it, cards display the raw fraction + "Building data" (spec §5.4).
 */
export const ON_TIME_LOW_N = 20

export interface OnTimeStop {
  /** Crew-closeout instant in UTC ISO form (`collection_stop.completed_at`). */
  completed_at: string
  /** Scheduled AWST collection date as YYYY-MM-DD (`collection_date.date`). */
  scheduledDate: string
}

export interface OnTimeResult {
  /** Count of valid completed stops (the denominator). */
  completed: number
  /** Count of completed stops whose AWST completion date matched the schedule. */
  onTime: number
  /** On-time percentage to 1 d.p., or null when there are no completed stops. */
  pct: number | null
  /** True when no completed stops are present (denominator 0). */
  isEmpty: boolean
  /** True when `0 < completed < ON_TIME_LOW_N` (raw fraction, no coloured pct). */
  isLowN: boolean
}

/** True when the AWST completion date of a stop equals its scheduled date. */
export function isOnTime(stop: OnTimeStop): boolean {
  return awstDateFromUtc(new Date(stop.completed_at)) === stop.scheduledDate
}

/** Returns true for a stop with a parseable completed_at + a scheduled date. */
function isValidStop(stop: OnTimeStop): boolean {
  if (!stop.completed_at || !stop.scheduledDate) return false
  return !Number.isNaN(new Date(stop.completed_at).getTime())
}

/**
 * Folds completed collection stops into the ONTIME metric. `pct` is null below
 * `ON_TIME_LOW_N` completed stops (and when there are none); above the threshold
 * it is the on-time share rounded to one decimal place.
 */
export function computeOnTime(stops: OnTimeStop[]): OnTimeResult {
  const valid = stops.filter(isValidStop)
  const completed = valid.length
  const onTime = valid.filter(isOnTime).length

  const isEmpty = completed === 0
  const isLowN = completed > 0 && completed < ON_TIME_LOW_N
  const pct =
    completed >= ON_TIME_LOW_N
      ? Math.round((onTime / completed) * 1000) / 10
      : null

  return { completed, onTime, pct, isEmpty, isLowN }
}
