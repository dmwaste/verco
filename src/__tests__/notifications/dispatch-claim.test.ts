/**
 * Atomic send claim (#671) — a retried dispatch never sends twice.
 *
 * `_shared/invoke-send-notification.ts` retries the EF→EF call on a 504 and on
 * its own 10 s abort. Both can fire AFTER the dispatcher has started, so the
 * retry runs a second dispatch while the first is still mid-send. The old
 * "is there a `sent` row?" check could not see an in-flight send (the row was
 * only written after SendGrid/Twilio answered), so the retry sent again and the
 * resident got two confirmations.
 *
 * The fix claims the `(booking_id, type, channel, reference_id)` key BEFORE
 * sending, by inserting a `queued` row under a partial unique index
 * (`notification_log_send_claim_key`, status IN queued/sent). The in-memory log
 * below enforces that same key, so these tests exercise the contract the EF
 * wires against Postgres.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claimNotificationSend,
  dispatch,
  STALE_CLAIM_AFTER_MS,
  type DispatchDeps,
  type SendClaimStore,
} from '@/lib/notifications/dispatch'
import type {
  BookingForDispatch,
  NotificationLogRow,
  SendEmailParams,
  SendEmailResult,
  SendSMSParams,
  SendSMSResult,
} from '@/lib/notifications/templates/types'
import { makeMockBooking } from './fixtures'

const BOOKING_ID = 'b-claim-1'
const NOW = Date.parse('2026-10-20T03:00:00Z')

type StoredRow = NotificationLogRow & { id: string; created_at: string }

/**
 * notification_log stand-in. `claimStore` enforces the partial unique key the
 * migration adds; `writeLog` is the plain insert the dispatcher falls back to
 * when no claim can be taken.
 */
function makeLog(initial: Array<Partial<StoredRow>> = []) {
  const rows: StoredRow[] = []
  let seq = 0
  const add = (row: NotificationLogRow, createdAt = NOW): StoredRow => {
    const stored = { ...row, id: `log-${++seq}`, created_at: new Date(createdAt).toISOString() }
    rows.push(stored)
    return stored
  }
  for (const r of initial) {
    add(
      {
        booking_id: BOOKING_ID,
        contact_id: 'contact-fixture-1',
        client_id: 'client-1',
        channel: 'email',
        notification_type: 'booking_created',
        to_address: 'x',
        status: 'sent',
        reference_id: null,
        ...r,
      } as NotificationLogRow,
      r.created_at ? Date.parse(r.created_at) : NOW,
    )
  }

  const sameKey = (a: NotificationLogRow, b: NotificationLogRow) =>
    a.booking_id === b.booking_id &&
    a.notification_type === b.notification_type &&
    a.channel === b.channel &&
    (a.reference_id ?? null) === (b.reference_id ?? null)
  const holds = (r: StoredRow) => r.status === 'queued' || r.status === 'sent'

  const claimStore: SendClaimStore = {
    insertClaim: async (row) => {
      if (rows.some((r) => holds(r) && sameKey(r, row))) return { conflict: true }
      return { id: add({ ...row, status: 'queued' }).id }
    },
    findHolder: async (row) => {
      const h = rows.find((r) => holds(r) && sameKey(r, row))
      return h ? { id: h.id, status: h.status, created_at: h.created_at } : null
    },
    releaseClaim: async (id, reason) => {
      const r = rows.find((x) => x.id === id && x.status === 'queued')
      if (!r) return false
      r.status = 'failed'
      r.error_message = reason
      return true
    },
  }

  const writeLog = async (row: NotificationLogRow) => add(row).id

  const updateLogStatus = vi.fn(async (id: string, status: 'sent' | 'failed', errorMessage?: string, toAddress?: string) => {
    const r = rows.find((x) => x.id === id)
    if (!r) return
    r.status = status
    if (errorMessage !== undefined) r.error_message = errorMessage
    if (toAddress !== undefined) r.to_address = toAddress
  })

  return { rows, claimStore, writeLog, updateLogStatus }
}

function smsBooking(overrides: Partial<BookingForDispatch> = {}): BookingForDispatch {
  const base = makeMockBooking({ id: BOOKING_ID })
  return {
    ...base,
    client: { ...base.client, twilio_messaging_service_sid: 'MG00000000000000000000000000000001' },
    ...overrides,
  }
}

/** A promise the test resolves by hand — holds a send "in flight". */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function harness(opts: {
  booking?: BookingForDispatch
  log?: ReturnType<typeof makeLog>
  sendEmail?: (params: SendEmailParams) => Promise<SendEmailResult>
  sendSMS?: (params: SendSMSParams) => Promise<SendSMSResult>
  claimSend?: DispatchDeps['claimSend']
}) {
  const log = opts.log ?? makeLog()
  const booking = opts.booking ?? smsBooking()
  const sendEmail = vi.fn<(params: SendEmailParams) => Promise<SendEmailResult>>(
    opts.sendEmail ?? (async () => ({ ok: true })),
  )
  const sendSMS = vi.fn<(params: SendSMSParams) => Promise<SendSMSResult>>(
    opts.sendSMS ?? (async () => ({ ok: true, messageSid: 'SM1' })),
  )
  const deps = {
    loadBooking: async (id: string) => (id === booking.id ? booking : null),
    claimSend: opts.claimSend ?? ((row: NotificationLogRow) => claimNotificationSend(log.claimStore, row, NOW)),
    writeLog: log.writeLog,
    updateLogStatus: log.updateLogStatus,
    sendEmail,
    sendSMS,
    loadNotificationLog: async () => null,
    loadRefundAmountCents: async () => null,
    appUrl: 'https://verco.test',
    defaultFromEmail: 'noreply@verco.test',
  } as DispatchDeps
  return { deps, log, sendEmail, sendSMS }
}

const PAYLOAD = { type: 'booking_created' as const, booking_id: BOOKING_ID }

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('dispatch — a retry inside the send window (#671)', () => {
  it('sends ONE email when the retry lands while the first dispatch is still sending', async () => {
    const firstSend = deferred<SendEmailResult>()
    let calls = 0
    const { deps, sendEmail } = harness({
      sendEmail: () => (++calls === 1 ? firstSend.promise : Promise.resolve({ ok: true as const })),
    })

    // Attempt 1: the gateway 504s / the invoker aborts while this is mid-send.
    const first = dispatch(deps, PAYLOAD)
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1))

    // Attempt 2: the invoker's retry runs a second dispatch for the same key.
    const second = await dispatch(deps, PAYLOAD)

    firstSend.resolve({ ok: true })
    await first

    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(second).toEqual({ ok: true, skipped: true })
  })

  it('sends ONE SMS when the retry lands while the first dispatch is still texting', async () => {
    const firstSms = deferred<SendSMSResult>()
    let calls = 0
    const { deps, sendSMS } = harness({
      sendSMS: () => (++calls === 1 ? firstSms.promise : Promise.resolve({ ok: true as const, messageSid: 'SM2' })),
    })

    const first = dispatch(deps, PAYLOAD)
    await vi.waitFor(() => expect(sendSMS).toHaveBeenCalledTimes(1))
    await dispatch(deps, PAYLOAD)
    firstSms.resolve({ ok: true, messageSid: 'SM1' })
    await first

    expect(sendSMS).toHaveBeenCalledTimes(1)
  })

  it('leaves exactly one sent row per channel after the window closes', async () => {
    const firstSend = deferred<SendEmailResult>()
    let calls = 0
    const { deps, log, sendEmail } = harness({
      sendEmail: () => (++calls === 1 ? firstSend.promise : Promise.resolve({ ok: true as const })),
    })

    const first = dispatch(deps, PAYLOAD)
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1))
    await dispatch(deps, PAYLOAD)
    firstSend.resolve({ ok: true })
    await first

    const sent = log.rows.filter((r) => r.status === 'sent')
    expect(sent.map((r) => r.channel).sort()).toEqual(['email', 'sms'])
    expect(log.rows.filter((r) => r.status === 'queued')).toHaveLength(0)
  })

  it('a failed send releases the key: the next dispatch sends', async () => {
    let calls = 0
    const { deps, log, sendEmail } = harness({
      sendEmail: async () => (++calls === 1 ? { ok: false as const, error: 'SendGrid 500' } : { ok: true as const }),
    })

    expect(await dispatch(deps, PAYLOAD)).toMatchObject({ ok: false, error: 'SendGrid 500' })
    expect(await dispatch(deps, PAYLOAD)).toMatchObject({ ok: true, sent: true })

    expect(sendEmail).toHaveBeenCalledTimes(2)
    const email = log.rows.filter((r) => r.channel === 'email').map((r) => r.status)
    expect(email).toEqual(['failed', 'sent'])
  })

  it('records the claim row as the log row (one row per attempt, not two)', async () => {
    const { deps, log } = harness({ booking: makeMockBooking({ id: BOOKING_ID }) })

    const result = await dispatch(deps, PAYLOAD)

    expect(result).toMatchObject({ ok: true, sent: true })
    expect(log.rows).toHaveLength(1)
    expect(log.rows[0]).toMatchObject({
      channel: 'email',
      status: 'sent',
      to_address: 'jane.resident@example.test',
    })
    expect(result.ok && 'log_id' in result && result.log_id).toBe(log.rows[0]!.id)
  })

  it('a missing contact email settles the claim as failed and still runs SMS', async () => {
    const base = smsBooking()
    const { deps, log, sendEmail, sendSMS } = harness({
      booking: { ...base, contact: { ...base.contact!, email: '' } },
    })

    const result = await dispatch(deps, PAYLOAD)

    expect(result).toMatchObject({ ok: false })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(log.rows.find((r) => r.channel === 'email')).toMatchObject({ status: 'failed', to_address: 'unknown' })
  })

  it('settles the email claim as failed when something throws after it was taken (never stranded queued)', async () => {
    const { deps, log, sendEmail } = harness({ booking: makeMockBooking({ id: BOOKING_ID }) })
    deps.loadRefundAmountCents = async () => {
      throw new Error('refund lookup exploded')
    }

    const result = await dispatch(deps, {
      type: 'booking_updated',
      booking_id: BOOKING_ID,
      edit_ref: '00000000-0000-4000-8000-0000000000e1',
      refund_request_id: '00000000-0000-4000-8000-0000000000r1',
    })

    expect(result).toMatchObject({ ok: false })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(log.rows).toHaveLength(1)
    expect(log.rows[0]).toMatchObject({ channel: 'email', status: 'failed' })
    expect(String(log.rows[0]!.error_message)).toContain('refund lookup exploded')
  })

  it('falls back to an unclaimed send when the claim itself errors — never a new way to lose a send', async () => {
    const { deps, log, sendEmail } = harness({
      booking: makeMockBooking({ id: BOOKING_ID }),
      claimSend: async () => ({ outcome: 'error', error: 'connection refused' }),
    })

    const result = await dispatch(deps, PAYLOAD)

    expect(result).toMatchObject({ ok: true, sent: true })
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(log.rows).toHaveLength(1)
    expect(log.rows[0]).toMatchObject({ channel: 'email', status: 'sent' })
  })
})

describe('dispatch — resume-by-log-id honours the row channel (#671)', () => {
  function resumeHarness(row: { channel: 'email' | 'sms'; to_address: string }, booking = smsBooking()) {
    const h = harness({ booking })
    h.deps.loadNotificationLog = async (id: string) =>
      id === 'log-retry'
        ? {
            booking_id: BOOKING_ID,
            notification_type: 'booking_created',
            status: 'queued',
            to_address: row.to_address,
            channel: row.channel,
          }
        : null
    return h
  }

  it('retrying a failed SMS row re-sends the SMS, not an email', async () => {
    const { deps, sendEmail, sendSMS, log } = resumeHarness({ channel: 'sms', to_address: '+61412345678' })

    const result = await dispatch(deps, { notification_log_id: 'log-retry' })

    expect(result).toMatchObject({ ok: true, sent: true, log_id: 'log-retry' })
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(sendSMS.mock.calls[0]![0]).toMatchObject({ to: '+61412345678' })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(log.updateLogStatus).toHaveBeenCalledWith('log-retry', 'sent', undefined, '+61412345678')
  })

  it('fails an SMS retry cleanly when the contact is no longer SMS-capable', async () => {
    const base = smsBooking()
    const { deps, sendEmail, sendSMS, log } = resumeHarness(
      { channel: 'sms', to_address: '+61412345678' },
      { ...base, contact: { ...base.contact!, mobile_e164: null } },
    )

    const result = await dispatch(deps, { notification_log_id: 'log-retry' })

    expect(result).toMatchObject({ ok: false, log_id: 'log-retry' })
    expect(sendSMS).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
    expect(log.updateLogStatus).toHaveBeenCalledWith('log-retry', 'failed', expect.stringContaining('SMS'))
  })

  it('an email row still resumes by email', async () => {
    const { deps, sendEmail, sendSMS } = resumeHarness({ channel: 'email', to_address: 'x' })

    const result = await dispatch(deps, { notification_log_id: 'log-retry' })

    expect(result).toMatchObject({ ok: true, sent: true })
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(sendSMS).not.toHaveBeenCalled()
  })
})

describe('claimNotificationSend', () => {
  const ROW: NotificationLogRow = {
    booking_id: BOOKING_ID,
    contact_id: 'c1',
    client_id: 'client-1',
    channel: 'email',
    notification_type: 'booking_created',
    reference_id: null,
    to_address: 'jane@example.test',
    status: 'queued',
  }

  it('claims a free key with a queued row', async () => {
    const log = makeLog()
    expect(await claimNotificationSend(log.claimStore, ROW, NOW)).toEqual({ outcome: 'claimed', id: 'log-1' })
    expect(log.rows[0]).toMatchObject({ status: 'queued', to_address: 'jane@example.test' })
  })

  it('is held by a sent row', async () => {
    const log = makeLog([{ status: 'sent' }])
    expect(await claimNotificationSend(log.claimStore, ROW, NOW)).toEqual({ outcome: 'held', by: 'sent' })
  })

  it('is held by a fresh queued claim (a dispatch still in flight)', async () => {
    const log = makeLog([{ status: 'queued', created_at: new Date(NOW - 60_000).toISOString() }])
    expect(await claimNotificationSend(log.claimStore, ROW, NOW)).toEqual({ outcome: 'held', by: 'queued' })
  })

  it('releases a stale claim (its dispatcher died) as failed and re-claims, so a resend can go out', async () => {
    const log = makeLog([{ status: 'queued', created_at: new Date(NOW - STALE_CLAIM_AFTER_MS - 1).toISOString() }])

    const claim = await claimNotificationSend(log.claimStore, ROW, NOW)

    expect(claim).toEqual({ outcome: 'claimed', id: 'log-2' })
    expect(log.rows[0]).toMatchObject({ status: 'failed' })
    expect(String(log.rows[0]!.error_message)).toMatch(/did not finish/)
    expect(log.rows[1]).toMatchObject({ status: 'queued' })
  })

  it('does not count a failed row as holding the key', async () => {
    const log = makeLog([{ status: 'failed' }])
    expect(await claimNotificationSend(log.claimStore, ROW, NOW)).toMatchObject({ outcome: 'claimed' })
  })

  it('keeps reference ids apart (a second per-stream notice is its own key)', async () => {
    const log = makeLog([{ status: 'sent', notification_type: 'ncn_raised', reference_id: 'ncn-1' }])
    const second = { ...ROW, notification_type: 'ncn_raised' as const, reference_id: 'ncn-2' }
    expect(await claimNotificationSend(log.claimStore, second, NOW)).toMatchObject({ outcome: 'claimed' })
    const dup = { ...ROW, notification_type: 'ncn_raised' as const, reference_id: 'ncn-1' }
    expect(await claimNotificationSend(log.claimStore, dup, NOW)).toEqual({ outcome: 'held', by: 'sent' })
  })

  it('surfaces a non-conflict insert error so the dispatcher can fall back', async () => {
    const store: SendClaimStore = {
      insertClaim: async () => ({ error: 'invalid input syntax for type uuid' }),
      findHolder: async () => null,
      releaseClaim: async () => false,
    }
    expect(await claimNotificationSend(store, ROW, NOW)).toEqual({
      outcome: 'error',
      error: 'invalid input syntax for type uuid',
    })
  })

  it('stays held when another dispatcher wins the race to release a stale claim', async () => {
    const stale = new Date(NOW - STALE_CLAIM_AFTER_MS - 1).toISOString()
    let inserts = 0
    const store: SendClaimStore = {
      insertClaim: async () => {
        inserts += 1
        return { conflict: true }
      },
      // First look: the stale claim. Second look: the winner's fresh claim.
      findHolder: async () =>
        inserts === 1
          ? { id: 'stale', status: 'queued', created_at: stale }
          : { id: 'winner', status: 'queued', created_at: new Date(NOW).toISOString() },
      releaseClaim: async () => false,
    }
    expect(await claimNotificationSend(store, ROW, NOW)).toEqual({ outcome: 'held', by: 'queued' })
  })
})
