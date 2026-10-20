import { describe, expect, it } from 'vitest'
import {
  buildHealthAlert,
  DEFAULT_THRESHOLDS,
  evaluateChannelHealth,
  findMissingConfirmations,
  findUnhealthyChannels,
  settledConfirmationBookingIds,
  type ChannelWindowStats,
  type HealthThresholds,
} from '@/lib/notifications/health'

const thresholds: HealthThresholds = { windowHours: 3, failureThreshold: 3 }

function stats(over: Partial<ChannelWindowStats> = {}): ChannelWindowStats {
  return {
    channel: 'email',
    sent: 0,
    failed: 0,
    lastErrorMessage: null,
    lastSuccessAt: null,
    ...over,
  }
}

describe('evaluateChannelHealth', () => {
  it('is healthy with successes and no failures', () => {
    const h = evaluateChannelHealth(stats({ sent: 5, failed: 0 }), thresholds)
    expect(h.healthy).toBe(true)
    expect(h.reasons).toEqual([])
  })

  it('is healthy on a quiet window (no attempts at all) — never false-alarms', () => {
    const h = evaluateChannelHealth(stats({ sent: 0, failed: 0 }), thresholds)
    expect(h.healthy).toBe(true)
  })

  it('stays healthy when failures sit below threshold alongside successes', () => {
    // 2 failed but 4 sent, threshold 3 → degraded but not flagged
    const h = evaluateChannelHealth(stats({ sent: 4, failed: 2 }), thresholds)
    expect(h.healthy).toBe(true)
  })

  it('flags a failure spike at or above the threshold', () => {
    const h = evaluateChannelHealth(stats({ sent: 10, failed: 3 }), thresholds)
    expect(h.healthy).toBe(false)
    expect(h.reasons.join(' ')).toContain('3 failed sends')
  })

  it('flags a fully dark channel (≥1 failure, 0 successes) even below the spike threshold', () => {
    // This is exactly the SendGrid-revocation shape: every send fails.
    const h = evaluateChannelHealth(stats({ sent: 0, failed: 1 }), thresholds)
    expect(h.healthy).toBe(false)
    expect(h.reasons.join(' ')).toContain('channel appears dark')
  })

  it('reports both reasons when a channel is both spiking and dark', () => {
    const h = evaluateChannelHealth(stats({ sent: 0, failed: 5 }), thresholds)
    expect(h.healthy).toBe(false)
    expect(h.reasons).toHaveLength(2)
  })

  it('passes through context fields for the alert', () => {
    const h = evaluateChannelHealth(
      stats({
        sent: 0,
        failed: 4,
        lastErrorMessage: 'SendGrid API error: 401',
        lastSuccessAt: '2026-05-18T06:54:39.959Z',
      }),
      thresholds,
    )
    expect(h.lastErrorMessage).toBe('SendGrid API error: 401')
    expect(h.lastSuccessAt).toBe('2026-05-18T06:54:39.959Z')
  })

  it('defaults to DEFAULT_THRESHOLDS when none passed', () => {
    expect(DEFAULT_THRESHOLDS.failureThreshold).toBe(3)
    const h = evaluateChannelHealth(stats({ sent: 0, failed: 3 }))
    expect(h.healthy).toBe(false)
  })
})

describe('findUnhealthyChannels', () => {
  it('returns only the unhealthy channels', () => {
    const result = findUnhealthyChannels(
      [
        stats({ channel: 'email', sent: 0, failed: 6 }),
        stats({ channel: 'sms', sent: 8, failed: 0 }),
      ],
      thresholds,
    )
    expect(result.map((r) => r.channel)).toEqual(['email'])
  })

  it('returns empty when all channels are healthy', () => {
    const result = findUnhealthyChannels(
      [
        stats({ channel: 'email', sent: 3, failed: 0 }),
        stats({ channel: 'sms', sent: 3, failed: 0 }),
      ],
      thresholds,
    )
    expect(result).toEqual([])
  })
})

describe('buildHealthAlert', () => {
  it('returns null when nothing is unhealthy', () => {
    expect(buildHealthAlert([], thresholds)).toBeNull()
  })

  it('renders the SendGrid-outage shape with channel, error and last success', () => {
    const unhealthy = findUnhealthyChannels(
      [
        stats({
          channel: 'email',
          sent: 0,
          failed: 22,
          lastErrorMessage: 'SendGrid API error: 401',
          lastSuccessAt: '2026-05-18T06:54:39.959Z',
        }),
      ],
      thresholds,
    )
    const msg = buildHealthAlert(unhealthy, thresholds)
    expect(msg).toContain('Verco notification health alert')
    expect(msg).toContain('EMAIL')
    expect(msg).toContain('SendGrid API error: 401')
    expect(msg).toContain('2026-05-18T06:54:39.959Z')
    expect(msg).toContain('SENDGRID_API_KEY')
  })

  it('shows "never" when a channel has no recorded success', () => {
    const unhealthy = findUnhealthyChannels(
      [stats({ channel: 'sms', sent: 0, failed: 4, lastSuccessAt: null })],
      thresholds,
    )
    const msg = buildHealthAlert(unhealthy, thresholds)
    expect(msg).toContain('SMS')
    expect(msg).toContain('last success: never')
  })
})

// ── Missing-confirmation backstop (18/10/2026) ──────────────────────────────
// A gateway 502 on the create-booking → send-notification hop left two live
// bookings (MOS-JOZCOM, KWN-2-I2NA9E) with no booking_created row of ANY
// status. The channel checks above can't see that — nothing was attempted —
// so the watchdog also diffs live bookings against the log.

describe('findMissingConfirmations', () => {
  const candidates = [
    { id: 'b1', ref: 'MOS-JOZCOM' },
    { id: 'b2', ref: 'KWN-2-I2NA9E' },
    { id: 'b3', ref: 'SOP-9CMXF4' },
  ]

  it('returns the refs of bookings with no booking_created row of any status', () => {
    const missing = findMissingConfirmations(candidates, new Set(['b3']))
    expect(missing).toEqual(['MOS-JOZCOM', 'KWN-2-I2NA9E'])
  })

  it('counts a failed row as an attempt — only a total absence is a miss', () => {
    // The caller writes a `failed` row when every retry is exhausted; that is
    // visible + retryable from admin, so it must not double-alert here.
    const missing = findMissingConfirmations(candidates, new Set(['b1', 'b2', 'b3']))
    expect(missing).toEqual([])
  })

  it('is empty when there are no candidates', () => {
    expect(findMissingConfirmations([], new Set())).toEqual([])
  })
})

// #671: a send now claims its key with a `queued` row BEFORE it sends. A
// dispatcher that dies mid-send strands that claim — it is a row, but nothing
// was confirmed — so it must still read as missing here (every candidate is
// already past the 15-minute settle, far longer than any live send).
describe('settledConfirmationBookingIds', () => {
  it('counts sent and failed rows as settled', () => {
    const ids = settledConfirmationBookingIds([
      { booking_id: 'b1', status: 'sent' },
      { booking_id: 'b2', status: 'failed' },
    ])
    expect([...ids].sort()).toEqual(['b1', 'b2'])
  })

  it('does not count a stranded queued claim — that booking is still unconfirmed', () => {
    const ids = settledConfirmationBookingIds([{ booking_id: 'b1', status: 'queued' }])
    expect(findMissingConfirmations([{ id: 'b1', ref: 'KWN-4-TEST01' }], ids)).toEqual(['KWN-4-TEST01'])
  })

  it('ignores rows with no booking', () => {
    expect(settledConfirmationBookingIds([{ booking_id: null, status: 'sent' }]).size).toBe(0)
  })
})

describe('buildHealthAlert — missing confirmations', () => {
  it('still returns null when channels are healthy and nothing is missing', () => {
    expect(buildHealthAlert([], thresholds, [])).toBeNull()
  })

  it('alerts on missing confirmations alone, naming the booking refs', () => {
    const msg = buildHealthAlert([], thresholds, ['MOS-JOZCOM', 'KWN-2-I2NA9E'])
    expect(msg).toContain('Verco notification health alert')
    expect(msg).toContain('2 live booking(s) with no booking_created notification')
    expect(msg).toContain('never finished')
    expect(msg).toContain('MOS-JOZCOM')
    expect(msg).toContain('KWN-2-I2NA9E')
  })

  it('appends the missing-confirmation section after the channel section', () => {
    const unhealthy = findUnhealthyChannels(
      [stats({ channel: 'sms', sent: 0, failed: 4, lastSuccessAt: null })],
      thresholds,
    )
    const msg = buildHealthAlert(unhealthy, thresholds, ['MOS-JOZCOM'])!
    expect(msg.indexOf('SMS')).toBeLessThan(msg.indexOf('MOS-JOZCOM'))
  })

  it('caps the listed refs and says how many more there are', () => {
    const refs = Array.from({ length: 12 }, (_, i) => `REF-${i + 1}`)
    const msg = buildHealthAlert([], thresholds, refs)!
    expect(msg).toContain('REF-10')
    expect(msg).not.toContain('REF-11')
    expect(msg).toContain('+2 more')
  })
})
