import { describe, it, expect, vi } from 'vitest'
import {
  authorizeNotificationDispatch,
  resolveTargetBookingId,
  validateDispatchInputShape,
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

  it('denies the cross-tenant refund exploit regardless of the forged refund reference', async () => {
    // Council-A staff JWT targeting a council-B booking with a forged refund
    // pointer (post-#406 the amount is derived server-side from the row, so a
    // caller can only forge the refund_request_id, not the cents).
    const deps = makeDeps({
      callerCanReadBooking: vi.fn(async () => false), // RLS hides council-B's booking
    })

    const result = await authorizeNotificationDispatch(
      {
        type: 'booking_updated',
        booking_id: 'council-b-booking',
        edit_ref: '2026-07-11T00:00:00Z',
        refund_status: 'processed',
        refund_request_id: 'council-a-refund-forged',
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

describe('validateDispatchInputShape — EF boundary contract', () => {
  it('accepts a fresh {type, booking_id} payload', () => {
    expect(
      validateDispatchInputShape({ type: 'booking_created', booking_id: 'b1' })
    ).toEqual({ ok: true })
  })

  it('accepts a resume {notification_log_id} payload', () => {
    expect(validateDispatchInputShape({ notification_log_id: 'log-1' })).toEqual({
      ok: true,
    })
  })

  it('rejects the HYBRID payload (both {type,booking_id} AND {notification_log_id}) with 400', () => {
    // The cross-tenant gate bypass: the tenant gate would authorize the caller's
    // OWN booking_id while dispatch() resumes the VICTIM's notification_log_id.
    const result = validateDispatchInputShape({
      type: 'booking_updated',
      booking_id: 'own-readable-booking',
      notification_log_id: 'victim-log',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error).toMatch(/not both/)
    }
  })

  it('rejects a hybrid carrying only notification_log_id + booking_id (no type) with 400', () => {
    const result = validateDispatchInputShape({
      booking_id: 'own-readable-booking',
      notification_log_id: 'victim-log',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('rejects a payload with neither shape (400)', () => {
    const result = validateDispatchInputShape({ foo: 'bar' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error).toMatch(/must include either/)
    }
  })

  it('rejects {type} without booking_id (incomplete fresh shape) as neither', () => {
    const result = validateDispatchInputShape({ type: 'booking_created' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('rejects non-object input (null, string) with 400', () => {
    for (const bad of [null, 'a string', 42, undefined]) {
      const result = validateDispatchInputShape(bad)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(400)
        expect(result.error).toMatch(/JSON object/)
      }
    }
  })
})

describe('resolveTargetBookingId — resume-first precedence', () => {
  it('resolves notification_log_id via loadLogBooking (log id FIRST)', async () => {
    const loadLogBooking = vi.fn(async () => 'booking-from-log')
    const result = await resolveTargetBookingId(
      { notification_log_id: 'log-1' },
      loadLogBooking
    )
    expect(result).toBe('booking-from-log')
    expect(loadLogBooking).toHaveBeenCalledWith('log-1')
  })

  it('prefers notification_log_id over booking_id when a (rejected-upstream) hybrid slips through', async () => {
    // The parse guard rejects hybrids at the boundary, but resolveTargetBookingId
    // must independently match dispatch()'s resume-first order so the gate and
    // the dispatcher can never authorize different bookings.
    const loadLogBooking = vi.fn(async () => 'booking-from-log')
    const hybrid = {
      type: 'booking_updated',
      booking_id: 'booking-from-payload',
      notification_log_id: 'log-1',
    } as unknown as NotificationDispatchInput
    const result = await resolveTargetBookingId(hybrid, loadLogBooking)
    expect(result).toBe('booking-from-log')
    expect(loadLogBooking).toHaveBeenCalledOnce()
  })

  it('resolves a fresh payload to its booking_id without touching loadLogBooking', async () => {
    const loadLogBooking = vi.fn(async () => 'should-not-be-used')
    const result = await resolveTargetBookingId(
      { type: 'booking_created', booking_id: 'b-direct' },
      loadLogBooking
    )
    expect(result).toBe('b-direct')
    expect(loadLogBooking).not.toHaveBeenCalled()
  })

  it('returns null when neither key resolves (e.g. empty notification_log_id)', async () => {
    const loadLogBooking = vi.fn(async () => null)
    const empty = { notification_log_id: '' } as unknown as NotificationDispatchInput
    expect(await resolveTargetBookingId(empty, loadLogBooking)).toBeNull()
    expect(loadLogBooking).not.toHaveBeenCalled()
  })
})
