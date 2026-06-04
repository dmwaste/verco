/**
 * Notification health evaluation — pure logic for the notification-outage
 * watchdog (VER-254).
 *
 * Background: we've had two silent, multi-day notification outages that only
 * surfaced during manual QA — the 14 Apr `verify_jwt` deploy bug, and the
 * 18 May SendGrid key revocation. A failed send writes a `failed` row to
 * `notification_log` and the caller swallows it (fire-and-forget by design),
 * so nothing watches that table.
 *
 * This module is the pure decision layer: given per-channel send counts over
 * a trailing window, decide whether each channel looks unhealthy and build a
 * human-readable alert. The Deno Edge Function
 * (`supabase/functions/notification-health-check/index.ts`) wires the real
 * `notification_log` queries + alert webhook into this same contract via a
 * mirrored copy in `supabase/functions/_shared/notification-health.ts`. Kept
 * in sync manually (same pattern as the dispatcher).
 */

export type NotificationChannel = 'email' | 'sms'

/** Per-channel send tallies over the trailing evaluation window. */
export interface ChannelWindowStats {
  channel: NotificationChannel
  /** Count of `status = 'sent'` rows in the window. */
  sent: number
  /** Count of `status = 'failed'` rows in the window. */
  failed: number
  /** Most recent failure's `error_message`, if any (for alert context). */
  lastErrorMessage: string | null
  /**
   * Timestamp (ISO) of the most recent successful send, which may predate the
   * window — surfaces "last good" context in the alert. Null if never sent.
   */
  lastSuccessAt: string | null
}

export interface HealthThresholds {
  /** Window size in hours — used only for alert message wording. */
  windowHours: number
  /**
   * A channel is unhealthy if it accrued at least this many failures in the
   * window, regardless of successes (catches partial degradation).
   */
  failureThreshold: number
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  windowHours: 3,
  failureThreshold: 3,
}

export interface ChannelHealth {
  channel: NotificationChannel
  healthy: boolean
  sent: number
  failed: number
  lastErrorMessage: string | null
  lastSuccessAt: string | null
  /** Human-readable reasons the channel was flagged (empty when healthy). */
  reasons: string[]
}

/**
 * Evaluate a single channel's health from its window stats.
 *
 * Unhealthy when EITHER:
 *   1. failures ≥ failureThreshold        — failure spike / partial degradation
 *   2. failures ≥ 1 AND successes === 0   — channel appears fully dark
 *
 * A channel with zero failures is always healthy — absence of attempts is not
 * an outage, and a quiet window must never raise a false alarm.
 */
export function evaluateChannelHealth(
  stats: ChannelWindowStats,
  thresholds: HealthThresholds = DEFAULT_THRESHOLDS,
): ChannelHealth {
  const reasons: string[] = []
  const { sent, failed } = stats
  const { windowHours, failureThreshold } = thresholds

  if (failed >= failureThreshold) {
    reasons.push(
      `${failed} failed send${failed === 1 ? '' : 's'} in the last ${windowHours}h ` +
        `(threshold ${failureThreshold})`,
    )
  }
  if (failed >= 1 && sent === 0) {
    reasons.push(
      `no successful sends in the last ${windowHours}h — channel appears dark ` +
        `(${failed} failed, 0 sent)`,
    )
  }

  return {
    channel: stats.channel,
    healthy: reasons.length === 0,
    sent,
    failed,
    lastErrorMessage: stats.lastErrorMessage,
    lastSuccessAt: stats.lastSuccessAt,
    reasons,
  }
}

/** Evaluate every channel; returns only the unhealthy ones. */
export function findUnhealthyChannels(
  stats: ChannelWindowStats[],
  thresholds: HealthThresholds = DEFAULT_THRESHOLDS,
): ChannelHealth[] {
  return stats
    .map((s) => evaluateChannelHealth(s, thresholds))
    .filter((h) => !h.healthy)
}

/**
 * Build the alert message for one or more unhealthy channels. Plain text with
 * a leading line — compatible with a Slack incoming webhook's `{ text }` body
 * and equally readable in any other sink. Returns null when nothing is
 * unhealthy (caller should not alert).
 */
export function buildHealthAlert(
  unhealthy: ChannelHealth[],
  thresholds: HealthThresholds = DEFAULT_THRESHOLDS,
): string | null {
  if (unhealthy.length === 0) return null

  const lines: string[] = [
    '🚨 Verco notification health alert',
    `${unhealthy.length} channel(s) failing over the last ${thresholds.windowHours}h:`,
    '',
  ]

  for (const ch of unhealthy) {
    lines.push(`• ${ch.channel.toUpperCase()} — ${ch.reasons.join('; ')}`)
    lines.push(
      `    last success: ${ch.lastSuccessAt ?? 'never'}` +
        (ch.lastErrorMessage ? ` · last error: ${ch.lastErrorMessage}` : ''),
    )
  }

  lines.push('')
  lines.push(
    'Check the send-notification Edge Function secrets ' +
      '(SENDGRID_API_KEY for email, Twilio config for SMS) and the SendGrid/Twilio dashboards.',
  )

  return lines.join('\n')
}
