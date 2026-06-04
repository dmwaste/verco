import { describe, expect, it } from 'vitest'
import {
  buildHealthAlert,
  DEFAULT_THRESHOLDS,
  evaluateChannelHealth,
  findUnhealthyChannels,
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
