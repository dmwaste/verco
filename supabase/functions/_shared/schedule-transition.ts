// Transition logic mirrored in src/lib/booking/schedule-transition.ts — keep in sync

/**
 * Pure helpers for the Confirmed → Scheduled daily cron.
 *
 * The cron fires at 15:25 AWST (07:25 UTC) each day. Bookings whose earliest
 * collection date is *tomorrow* AWST transition to Scheduled, because the
 * cancellation cutoff (15:30 AWST the day prior) is about to pass.
 *
 * Using MIN(collection_date.date) matches the enforce_cancellation_cutoff
 * trigger — keep aligned if the cutoff semantics ever change.
 */

export interface BookingWithItemDates {
  id: string
  booking_item: Array<{ collection_date: { date: string } | null }>
}

/**
 * Returns the AWST calendar date (YYYY-MM-DD) for the given UTC instant.
 * AWST is UTC+8 year-round (no DST).
 */
export function awstDateFromUtc(nowUtc: Date): string {
  const awstMs = nowUtc.getTime() + 8 * 60 * 60 * 1000
  return new Date(awstMs).toISOString().slice(0, 10)
}

/** Returns YYYY-MM-DD for the day after the given YYYY-MM-DD string. */
export function addOneDay(yyyymmdd: string): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Filters bookings whose earliest collection_date is on or before targetDate.
 * Returns IDs. Bookings with zero valid dates are skipped — callers that need
 * visibility on that case should inspect inputs separately.
 *
 * <= (not ===) so stragglers transition: a booking confirmed AFTER the daily
 * 15:25 tick for tomorrow (e.g. an NCN/NP rebook created that evening, which
 * lands directly in Confirmed) is caught on the next tick instead of sitting
 * Confirmed forever —
 * which matters because the collection_stop rollup only completes bookings
 * that reached Scheduled.
 */
export function filterBookingsReadyToSchedule(
  bookings: BookingWithItemDates[],
  targetDate: string,
): string[] {
  const ids: string[] = []
  for (const booking of bookings) {
    const dates = booking.booking_item
      .map((item) => item.collection_date?.date)
      .filter((d): d is string => Boolean(d))
    if (dates.length === 0) continue
    const earliest = dates.reduce((min, d) => (d < min ? d : min))
    if (earliest <= targetDate) ids.push(booking.id)
  }
  return ids
}

/**
 * Page size for the Confirmed-booking fetch.
 *
 * Deliberately BELOW Supabase's db-max-rows (1000 on this project). PostgREST
 * silently truncates any response above that cap, and a truncated page is
 * indistinguishable from an exhausted one — so a page size AT the cap would
 * make "short page" ambiguous and could stop paging early. Staying under it
 * keeps "fewer rows than asked for" an unambiguous end-of-set signal.
 */
export const CONFIRMED_PAGE_SIZE = 500

export interface BookingPage<T = BookingWithItemDates> {
  rows: T[]
  error?: string
}

/** Fetches one inclusive [from, to] slice of Confirmed bookings, stably ordered. */
export type FetchBookingPage<T = BookingWithItemDates> = (
  from: number,
  to: number,
) => Promise<BookingPage<T>>

export type FetchAllResult<T = BookingWithItemDates> =
  | { ok: true; rows: T[] }
  | { ok: false; error: string }

/**
 * Pages through every Confirmed booking.
 *
 * Why this exists: the cron used to fetch all Confirmed bookings in ONE
 * unpaginated call. Once the Confirmed set passed 1,000 rows, PostgREST
 * capped the response and the surplus bookings became invisible — they never
 * transitioned to Scheduled, so the field crew could not close them out
 * (Completed/NCN/NP are only reachable FROM Scheduled). It failed silently:
 * the cron still reported failed:0 and HTTP 200, because nothing counts rows
 * it never received. On 24/08/2026 that stranded KWN-2-B2IX82 and
 * KWN-2-XZSK8X out of 1,172 Confirmed bookings. send-collection-reminders
 * shared the same fetch shape, silently skipping reminders for the same slice.
 *
 * The caller MUST apply a stable `.order()` inside fetchPage — unordered
 * `.range()` paging overlaps and skips rows while still returning a
 * plausible-looking total.
 *
 * Returns an error rather than a partial set: a short read here would
 * reproduce the exact bug this function exists to prevent.
 */
export async function fetchAllConfirmedBookings<T = BookingWithItemDates>(
  fetchPage: FetchBookingPage<T>,
  pageSize: number = CONFIRMED_PAGE_SIZE,
): Promise<FetchAllResult<T>> {
  const rows: T[] = []

  for (let from = 0; ; from += pageSize) {
    const page = await fetchPage(from, from + pageSize - 1)
    if (page.error) return { ok: false, error: page.error }

    rows.push(...page.rows)
    if (page.rows.length < pageSize) break
  }

  return { ok: true, rows }
}

export interface BudgetRunResult {
  /** Items the worker finished (rate-limited attempts that were re-queued don't count). */
  started: number
  /** Items never finished because the deadline passed (incl. any re-queued after a rate limit). */
  remaining: number
}

/**
 * A worker returns this when the platform rate-limited it: the item goes back
 * to the front of the queue and EVERY lane waits `retryAfterMs` before starting
 * anything else (the next call would be refused too).
 */
export interface RateLimited {
  retryAfterMs: number
}

/**
 * Runs `worker` over `items` in order, at most `concurrency` at a time, and
 * stops STARTING items once `deadlineMs` (epoch ms) has passed. Items already
 * in flight are always awaited. The worker must not reject — catch inside it.
 *
 * Why: send-collection-reminders used to await one send-notification call per
 * booking (~1.3 s each). The edge gateway answers 504 at 150 s and the worker
 * is killed soon after, so every busy 09:00 run silently stopped after ~125–157
 * bookings — the rest never got a reminder (12/10/2026, WMRC). Concurrency
 * clears a full day in seconds; the deadline turns any overflow into a counted
 * `remaining` the caller can report, instead of a mid-loop kill.
 *
 * Concurrency then ran into Supabase's limit on one edge function calling
 * another (~60 calls per window on 13/10/2026): a worker that returns
 * `RateLimited` re-queues its item and pauses all lanes until the window
 * reopens. A pause that would outlast the deadline ends the run instead — the
 * leftovers are `remaining`, never a sleep past the edge gateway's 150 s.
 */
export async function runWithinBudget<T>(
  items: T[],
  opts: { concurrency: number; deadlineMs: number },
  worker: (item: T) => Promise<void | RateLimited>,
): Promise<BudgetRunResult> {
  const queue = [...items]
  let finished = 0
  let pausedUntil = 0
  const lane = async () => {
    while (queue.length > 0) {
      if (pausedUntil >= opts.deadlineMs) return
      const wait = pausedUntil - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      if (queue.length === 0 || Date.now() >= opts.deadlineMs) return
      const item = queue.shift() as T
      const outcome = await worker(item)
      if (outcome && outcome.retryAfterMs > 0) {
        pausedUntil = Math.max(pausedUntil, Date.now() + outcome.retryAfterMs)
        queue.unshift(item)
      } else {
        finished++
      }
    }
  }
  const lanes = Math.max(1, Math.min(opts.concurrency, items.length))
  await Promise.all(Array.from({ length: lanes }, lane))
  return { started: finished, remaining: queue.length }
}

/**
 * Wait (ms) demanded by an edge-runtime `RateLimitError` thrown from `fetch()`
 * to another edge function, or null for any other error. Reads the error's
 * `retryAfterMs`, falls back to the "Retry after Nms" text, then to a minute.
 * Duck-typed on `name` — the class isn't in the Deno type defs `deno check` uses.
 */
export function rateLimitRetryAfterMs(err: unknown): number | null {
  if (!(err instanceof Error) || err.name !== 'RateLimitError') return null
  const declared = (err as Error & { retryAfterMs?: unknown }).retryAfterMs
  if (typeof declared === 'number' && declared > 0) return declared
  const parsed = /Retry after (\d+)\s*ms/i.exec(err.message)
  return parsed ? Number(parsed[1]) : 60_000
}

/**
 * Booking ids whose collection_reminder is already `sent` on BOTH email and
 * SMS. The reminder cron skips these before calling send-notification: a
 * no-op call still spends the per-minute function-to-function budget, which
 * on 13/10 starved the 09:20 retry of the bookings that actually needed it.
 * A booking with only one channel sent is still re-invoked (send-notification
 * skips the sent channel and retries the other).
 */
export function remindedOnBothChannels(rows: Array<{ booking_id: string | null; channel: string }>): Set<string> {
  const channels = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!r.booking_id) continue
    const set = channels.get(r.booking_id) ?? new Set<string>()
    set.add(r.channel)
    channels.set(r.booking_id, set)
  }
  const done = new Set<string>()
  for (const [id, set] of channels) if (set.has('email') && set.has('sms')) done.add(id)
  return done
}

/**
 * HTTP status for a send-collection-reminders run:
 *   200 — every candidate was sent.
 *   207 — some were not sent (budget spent or a send failed), but a later tick
 *         today retries them. A busy morning, not an outage.
 *   500 — some were not sent and no tick is left today: those residents get no
 *         reminder unless someone runs scripts/send-reminder-catchup.ts.
 *
 * Why: the run was 500ing whenever it handed work to the next tick, which is
 * the design on any day over ~120 bookings. On 19/10/2026 the 09:00 and 09:10
 * ticks both 500'd (Sentry JAVASCRIPT-NEXTJS-T) and the 09:20/09:30 ticks
 * reminded all 188 — so Sentry cried wolf every busy day. Only the last tick
 * can tell a real miss.
 *
 * `lastTick` comes from the cron job itself (`{"last_tick": false}` on the
 * earlier ticks, `true` on the last — migration 20261020015939), so the
 * schedule lives in one place. A run without the flag (manual, or a tick added
 * later without it) counts as the last: it alerts rather than hides a miss.
 */
export function reminderRunStatus(
  run: { failed: number; remaining: number },
  lastTick: boolean,
): 200 | 207 | 500 {
  if (run.failed === 0 && run.remaining === 0) return 200
  return lastTick ? 500 : 207
}
