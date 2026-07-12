import { describe, it, expect } from 'vitest'
import { dispatch, type DispatchDeps } from '@/lib/notifications/dispatch'
import type {
  BookingForDispatch,
  NotificationLogRow,
  SendEmailParams,
  SendSMSParams,
} from '@/lib/notifications/templates/types'

// Dispatcher coverage for the `booking_updated` notification (#388). Two
// properties matter for the inline quantity editor + date-change flows:
//   1. Idempotency is keyed per EDIT (edit_ref), not per booking — so a later
//      edit's email is never suppressed by an earlier edit's log row, while a
//      retry of the SAME edit dedupes.
//   2. booking_updated is email-only (SMS Phase 1 = booking_created +
//      collection_reminder), so it must never attempt an SMS even when the
//      contact and tenant are fully SMS-eligible.

const B1 = '9a1f6f2e-1c6b-4a1e-9f7d-2b8c3d4e5f60'

function makeBooking(): BookingForDispatch {
  return {
    id: B1,
    ref: 'KWN-1-QTY001',
    type: 'Residential',
    client_id: 'client-1',
    address: '23 Leda Blvd, Wellard',
    collection_date: '2026-08-20',
    total_charge_cents: 0,
    items: [{ service_name: 'Mattress', no_services: 1, is_extra: false, line_charge_cents: 0 }],
    client: {
      name: 'City of Kwinana',
      logo_light_url: null,
      primary_colour: '#00E47C',
      email_footer_html: null,
      slug: 'kwinana',
      custom_domain: null,
      reply_to_email: 'bookings@verco.au',
      email_from_name: 'City of Kwinana',
      // SMS-eligible tenant — present so the "no SMS" test proves the TYPE gate,
      // not a missing Messaging Service SID.
      twilio_messaging_service_sid: 'MG00000000000000000000000000000000',
    },
    contact: {
      id: 'c1',
      full_name: 'Jane Resident',
      email: 'jane@example.com',
      // Valid AU mobile so SMS eligibility passes every check except the type.
      mobile_e164: '+61412345678',
    },
  }
}

interface Harness {
  deps: DispatchDeps
  emailSends: SendEmailParams[]
  smsSends: SendSMSParams[]
}

/**
 * Deps mock with a real per-(booking,type,channel,ref) idempotency ledger:
 * a successful email `writeLog` records the key that a later `isAlreadySent`
 * checks — exactly how notification_log gates a repeat send in prod.
 */
function makeHarness(booking: BookingForDispatch = makeBooking()): Harness {
  const sentKeys = new Set<string>()
  const emailSends: SendEmailParams[] = []
  const smsSends: SendSMSParams[] = []
  const key = (bookingId: string, type: string, channel: string, ref: string | null | undefined) =>
    `${bookingId}|${type}|${channel}|${ref ?? 'null'}`

  const deps: DispatchDeps = {
    loadBooking: async () => booking,
    isAlreadySent: async (bookingId, type, channel, ref) =>
      sentKeys.has(key(bookingId, type, channel, ref)),
    writeLog: async (row: NotificationLogRow) => {
      if (row.status === 'sent') {
        sentKeys.add(key(row.booking_id, row.notification_type, row.channel, row.reference_id))
      }
      return 'log-1'
    },
    sendEmail: async (params) => {
      emailSends.push(params)
      return { ok: true }
    },
    sendSMS: async (params) => {
      smsSends.push(params)
      return { ok: true }
    },
    loadNotificationLog: async () => null,
    updateLogStatus: async () => {},
    loadRefundAmountCents: async () => null,
    appUrl: 'https://verco.au',
    defaultFromEmail: 'bookings@verco.au',
  }
  return { deps, emailSends, smsSends }
}

describe('dispatch — booking_updated idempotency by edit_ref', () => {
  it('sends both when two edits carry different edit_ref values', async () => {
    const { deps, emailSends } = makeHarness()

    const r1 = await dispatch(deps, { type: 'booking_updated', booking_id: B1, edit_ref: 'edit-A' })
    const r2 = await dispatch(deps, { type: 'booking_updated', booking_id: B1, edit_ref: 'edit-B' })

    expect(r1).toMatchObject({ ok: true, sent: true })
    expect(r2).toMatchObject({ ok: true, sent: true })
    expect(emailSends).toHaveLength(2)
  })

  it('dedupes the second send when the SAME edit_ref repeats (a retry)', async () => {
    const { deps, emailSends } = makeHarness()

    const first = await dispatch(deps, { type: 'booking_updated', booking_id: B1, edit_ref: 'edit-A' })
    const second = await dispatch(deps, { type: 'booking_updated', booking_id: B1, edit_ref: 'edit-A' })

    expect(first).toMatchObject({ ok: true, sent: true })
    expect(second).toEqual({ ok: true, skipped: true })
    expect(emailSends).toHaveLength(1)
  })
})

describe('dispatch — booking_updated is email-only', () => {
  it('never attempts an SMS even when the contact and tenant are SMS-eligible', async () => {
    const { deps, emailSends, smsSends } = makeHarness()

    const r = await dispatch(deps, { type: 'booking_updated', booking_id: B1, edit_ref: 'edit-A' })

    expect(r).toMatchObject({ ok: true, sent: true })
    expect(emailSends).toHaveLength(1)
    // Mobile present + Messaging Service SID present, yet no SMS: the type has
    // no SMS variant (renderSmsTemplate returns null for booking_updated).
    expect(smsSends).toHaveLength(0)
  })
})
