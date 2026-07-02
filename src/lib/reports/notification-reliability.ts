/**
 * NOTIF — Notification Reliability calc for the SLA dashboard (VER-179, spec §3.7).
 *
 * Email-only delivery reliability:
 *   delivered% = positive / (positive + negative) × 100
 *
 * `notification_log.delivery_status` is a ranked SendGrid lifecycle that never
 * downgrades. We fold a flat array of those status strings (already filtered to
 * `channel='email'` + non-null by the caller's PostgREST query) into a single
 * reliability figure:
 *
 *   positive = 'delivered' | 'opened'   — 'opened' supersedes 'delivered'; it
 *              MUST be counted as a success or the rate undercounts.
 *   negative = 'bounced' | 'dropped' | 'spam'
 *   excluded = 'deferred' (transient, will retry) + null/empty/unknown — these
 *              never enter the denominator so they cannot dilute the rate.
 *
 * Pure + deterministic: no Supabase, no network, no wall-clock reads — it folds
 * the stored statuses passed in. SMS is permanently out of scope (Twilio status
 * callbacks are not wired, so `delivery_status` is always null for SMS — §2).
 *
 * Status matching is case-insensitive and trims surrounding whitespace so a
 * webhook value like `' Delivered '` scores identically to `'delivered'`.
 */

/** Below this many tracked rows the card shows the raw fraction, not a coloured %. */
export const NOTIF_LOW_N = 10

/** Internal reliability target (~98%) — soft reference line, never error-red pre-go-live. */
export const NOTIF_TARGET_PCT = 98

const POSITIVE_STATUSES = new Set(['delivered', 'opened'])
const NEGATIVE_STATUSES = new Set(['bounced', 'dropped', 'spam'])

export interface NotificationReliabilityResult {
  /** Count of delivered/opened email rows. */
  positive: number
  /** Count of bounced/dropped/spam email rows. */
  negative: number
  /** positive + negative — the SLA denominator (deferred/null/unknown excluded). */
  tracked: number
  /** positive / tracked × 100, or null when tracked === 0. */
  pct: number | null
  /** No tracked rows at all. */
  isEmpty: boolean
  /** 0 < tracked < NOTIF_LOW_N — show the raw fraction, suppress the coloured %. */
  isLowN: boolean
}

/**
 * Fold email delivery statuses into the reliability figure.
 *
 * @param statuses delivery_status values for email rows (null allowed; the
 *                 caller may pass raw rows with nulls — they are excluded here
 *                 so the function is robust to either pre-filtered or raw input)
 */
export function computeNotificationReliability(
  statuses: ReadonlyArray<string | null | undefined>,
): NotificationReliabilityResult {
  let positive = 0
  let negative = 0

  for (const raw of statuses) {
    if (raw == null) continue
    const status = raw.trim().toLowerCase()
    if (status === '') continue
    if (POSITIVE_STATUSES.has(status)) positive += 1
    else if (NEGATIVE_STATUSES.has(status)) negative += 1
    // deferred / unknown / sent / processed → excluded (not counted either way)
  }

  const tracked = positive + negative
  const pct = tracked === 0 ? null : (positive / tracked) * 100

  return {
    positive,
    negative,
    tracked,
    pct,
    isEmpty: tracked === 0,
    isLowN: tracked > 0 && tracked < NOTIF_LOW_N,
  }
}
