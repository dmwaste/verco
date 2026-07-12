import { describe, it, expect, vi } from 'vitest'
import {
  authorizeNotificationDispatch,
  type NotificationAuthzDeps,
} from '@/lib/notifications/authz'
import type {
  NotificationDispatchInput,
  NotificationPayload,
} from '@/lib/notifications/templates/types'

/**
 * Tenant-scope authorization for the send-notification EF's user-JWT path.
 *
 * The EF loads bookings with the SERVICE-ROLE client (RLS-bypassing) so it can
 * read contact + branding. A user-JWT caller that only passed the *role* gate
 * could therefore fire a notification for ANY tenant's booking — the reported
 * cross-tenant refund-email exploit. `authorizeNotificationDispatch` re-imposes
 * the caller's own RLS scope by requiring the caller to be able to read the
 * target booking before any dispatch happens.
 */

function makeDeps(
  overrides: Partial<NotificationAuthzDeps> = {}
): NotificationAuthzDeps {
  return {
    isServiceRole: false,
    resolveBookingId: vi.fn(async (input: NotificationDispatchInput) =>
      'booking_id' in input ? input.booking_id : null
    ),
    callerCanReadBooking: vi.fn(async () => true),
    ...overrides,
  }
}

describe('authorizeNotificationDispatch', () => {
  it('bypasses all scope checks for the service-role (EF→EF) path without any I/O', async () => {
    const deps = makeDeps({ isServiceRole: true })

    const result = await authorizeNotificationDispatch(
      { type: 'booking_created', booking_id: 'b1' },
      deps
    )

    expect(result).toEqual({ ok: true })
    // Trusted server context — must not touch the DB at all.
    expect(deps.resolveBookingId).not.toHaveBeenCalled()
    expect(deps.callerCanReadBooking).not.toHaveBeenCalled()
  })

  it('allows a user-JWT caller when their own RLS can read the target booking', async () => {
    const deps = makeDeps({
      callerCanReadBooking: vi.fn(async () => true),
    })

    const result = await authorizeNotificationDispatch(
      { type: 'booking_cancelled', booking_id: 'own-booking' },
      deps
    )

    expect(result).toEqual({ ok: true })
    expect(deps.callerCanReadBooking).toHaveBeenCalledWith('own-booking')
  })

  it('denies the cross-tenant refund exploit regardless of the forged amount', async () => {
    // Council-A staff JWT targeting a council-B booking with a forged refund.
    const deps = makeDeps({
      callerCanReadBooking: vi.fn(async () => false), // RLS hides council-B's booking
    })

    const result = await authorizeNotificationDispatch(
      {
        type: 'booking_updated',
        booking_id: 'council-b-booking',
        edit_ref: '2026-07-11T00:00:00Z',
        refund_status: 'processed',
        refund_cents: 999_999,
      },
      deps
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it('fails closed when the target booking cannot be resolved', async () => {
    const deps = makeDeps({
      resolveBookingId: vi.fn(async () => null),
      callerCanReadBooking: vi.fn(async () => true),
    })

    const result = await authorizeNotificationDispatch(
      { notification_log_id: 'log-1' },
      deps
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
    // Never fall through to the scope read on an unresolved target.
    expect(deps.callerCanReadBooking).not.toHaveBeenCalled()
  })

  it('gates the resume (notification_log_id) path on the resolved booking', async () => {
    // Attacker passes another tenant's log id; resolution maps it to that
    // tenant's booking, which the caller's RLS cannot read → deny.
    const deps = makeDeps({
      resolveBookingId: vi.fn(async () => 'council-b-booking'),
      callerCanReadBooking: vi.fn(async () => false),
    })

    const result = await authorizeNotificationDispatch(
      { notification_log_id: 'council-b-log' },
      deps
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
    expect(deps.callerCanReadBooking).toHaveBeenCalledWith('council-b-booking')
  })

  it('gates every user-JWT payload type on the tenant scope, not just booking_updated', async () => {
    // The finding calls out that ALL payloads reaching the EF from user-JWT
    // paths must be scoped — not only the refund carrier.
    const payloads: NotificationPayload[] = [
      { type: 'booking_created', booking_id: 'x' },
      { type: 'booking_cancelled', booking_id: 'x' },
      {
        type: 'booking_updated',
        booking_id: 'x',
        edit_ref: '2026-07-11T00:00:00Z',
      },
      { type: 'ncn_raised', booking_id: 'x', ncn_id: 'n', reason: 'r' },
      { type: 'np_raised', booking_id: 'x', np_id: 'n' },
      { type: 'completion_survey', booking_id: 'x', survey_token: 't' },
    ]

    for (const payload of payloads) {
      const deps = makeDeps({ callerCanReadBooking: vi.fn(async () => false) })
      const result = await authorizeNotificationDispatch(payload, deps)
      expect(result.ok, `${payload.type} must be denied when out of scope`).toBe(
        false
      )
    }
  })
})
