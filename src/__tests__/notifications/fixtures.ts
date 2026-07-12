/**
 * Shared test fixtures for the notifications module.
 *
 * Phase 0 landed 3 ClientBranding fixtures. Phase 1 (VER-119) extends this
 * file with full booking/contact/item fixtures plus a `createMockDispatchDeps`
 * factory used by `dispatch.test.ts` to exercise the orchestration logic
 * without hitting Supabase or SendGrid.
 */

import { vi } from 'vitest'
import type {
  ClientBranding,
  NotificationChannel,
  NotificationType,
} from '@/lib/notifications/templates/types'
import type {
  BookingForDispatch,
  DispatchDeps,
  NotificationLogRow,
  SendEmailParams,
  SendEmailResult,
  SendSMSParams,
  SendSMSResult,
} from '@/lib/notifications/dispatch'

// ── ClientBranding fixtures (Phase 0) ──────────────────────────────────────

/**
 * Fully branded tenant — logo, primary colour, custom footer.
 * Use this when verifying the template renders all branding slots.
 */
export const mockClientFull: ClientBranding & { id: string } = {
  id: 'client-fixture-full',
  name: 'City of Mock',
  logo_light_url: 'https://cdn.example.com/mock-logo.png',
  primary_colour: '#0055AA',
  email_footer_html:
    '<p style="margin:0;color:#666;font-size:11px">City of Mock — reply to info@mock.wa.gov.au</p>',
}

/**
 * Unbranded fallback tenant — null logo, null colour, null footer.
 * Use this when verifying the template falls back to defaults cleanly.
 */
export const mockClientMinimal: ClientBranding & { id: string } = {
  id: 'client-fixture-minimal',
  name: 'Bare Council',
  logo_light_url: null,
  primary_colour: null,
  email_footer_html: null,
}

/**
 * Tenant with an un-prefixed hex colour — used to verify the `normaliseHex`
 * helper prepends the `#`.
 */
export const mockClientUnprefixedColour: ClientBranding & { id: string } = {
  id: 'client-fixture-unprefixed',
  name: 'Loose Colour Council',
  logo_light_url: null,
  primary_colour: '00E47C',
  email_footer_html: null,
}

// ── Booking fixtures (Phase 1) ─────────────────────────────────────────────

/**
 * Factory for a realistic BookingForDispatch — the data shape the dispatcher
 * loads from Supabase in production. All fields defaulted; callers override
 * only what matters for their test.
 */
export function makeMockBooking(
  overrides: Partial<BookingForDispatch> = {}
): BookingForDispatch {
  return {
    id: 'booking-fixture-1',
    ref: 'VV-ABC123',
    type: 'Residential',
    client_id: mockClientMinimal.id,
    address: '23 Leda Blvd, Wellard WA 6170',
    client: {
      slug: 'mock-tenant',
      custom_domain: null,
      reply_to_email: 'noreply@mock.wa.gov.au',
      email_from_name: 'City of Mock — Verge Collection',
      twilio_messaging_service_sid: null,
      ...mockClientMinimal,
    },
    contact: {
      id: 'contact-fixture-1',
      full_name: 'Jane Resident',
      email: 'jane.resident@example.test',
      mobile_e164: '+61412345678',
    },
    collection_date: '2026-04-15',
    items: [
      { service_name: 'General', no_services: 2, is_extra: false, line_charge_cents: 0 },
      { service_name: 'Green Waste', no_services: 1, is_extra: false, line_charge_cents: 0 },
    ],
    total_charge_cents: 0,
    ...overrides,
  }
}

/**
 * Booking variant with a paid extra — used by booking_created tests to
 * verify the details table shows "1 Paid" with a line charge.
 */
export function makeMockPaidBooking(): BookingForDispatch {
  return makeMockBooking({
    items: [
      { service_name: 'General', no_services: 2, is_extra: false, line_charge_cents: 0 },
      { service_name: 'General', no_services: 1, is_extra: true, line_charge_cents: 5500 },
    ],
    total_charge_cents: 5500,
  })
}

/**
 * PII-laced booking — used by the PII regression test to prove the template
 * does not leak contact fields into the rendered HTML for field-visible paths.
 */
export const PII_STRINGS = {
  full_name: 'JaneUniquePIINameXYZ',
  email: 'jane-unique-pii@pii.test',
  mobile_e164: '+61499000042',
} as const

export function makePiiLoadedBooking(): BookingForDispatch {
  return makeMockBooking({
    contact: {
      id: 'contact-pii-fixture',
      full_name: PII_STRINGS.full_name,
      email: PII_STRINGS.email,
      mobile_e164: PII_STRINGS.mobile_e164,
    },
  })
}

// ── DispatchDeps factory (Phase 1) ─────────────────────────────────────────

export interface MockDispatchState {
  /** Bookings keyed by id. Return null from loadBooking if missing. */
  bookings?: Record<string, BookingForDispatch>
  /**
   * Existing notification_log rows — the idempotency check reads this.
   * Structure: list of `{booking_id, notification_type, channel, status}`.
   * `channel` defaults to 'email' when omitted (back-compat with older tests).
   */
  existingLog?: Array<{
    booking_id: string
    notification_type: NotificationType
    status: 'queued' | 'sent' | 'failed'
    channel?: NotificationChannel
    /** Per-notice key (ncn_id / np_id) — null/omitted = booking-level row. */
    reference_id?: string | null
  }>
  /**
   * What `sendEmail` should return. Default: `{ ok: true }`.
   */
  sendResult?: SendEmailResult
  /**
   * What `sendSMS` should return. Default: `{ ok: true, messageSid: 'SM-mock' }`.
   */
  smsResult?: SendSMSResult
  /**
   * Queued notification_log rows for the resume-by-log-id path.
   * Keyed by log id.
   */
  queuedLogs?: Record<string, {
    booking_id: string
    notification_type: NotificationType
    status: 'queued' | 'sent' | 'failed'
    to_address: string
  }>
  /**
   * Authoritative refund_request amounts keyed by refund_request_id — the
   * booking_updated refund derivation reads this via loadRefundAmountCents.
   * A missing key returns null (row not found / not this booking).
   */
  refundAmounts?: Record<string, number>
}

export interface MockDispatchDeps extends DispatchDeps {
  /** Spy on all sendEmail calls. */
  sendEmailMock: ReturnType<typeof vi.fn>
  /** Spy on all sendSMS calls. */
  sendSMSMock: ReturnType<typeof vi.fn>
  /** Spy on all writeLog calls. */
  writeLogMock: ReturnType<typeof vi.fn>
  /** All notification_log rows that would have been written in this run. */
  writtenLogs: NotificationLogRow[]
  /** Spy on all updateLogStatus calls. */
  updateLogStatusMock: ReturnType<typeof vi.fn>
  /** Spy on all loadRefundAmountCents calls. */
  loadRefundAmountCentsMock: ReturnType<typeof vi.fn>
}

export function createMockDispatchDeps(
  state: MockDispatchState = {}
): MockDispatchDeps {
  const writtenLogs: NotificationLogRow[] = []

  const writeLogMock = vi.fn(async (row: NotificationLogRow) => {
    writtenLogs.push(row)
    return `log-${writtenLogs.length}`
  })

  const sendEmailMock = vi.fn(async (_params: SendEmailParams) => {
    return state.sendResult ?? { ok: true as const }
  })

  const sendSMSMock = vi.fn(async (_params: SendSMSParams) => {
    return state.smsResult ?? { ok: true as const, messageSid: 'SM-mock' }
  })

  const updateLogStatusMock = vi.fn(async () => {})

  const loadRefundAmountCentsMock = vi.fn(
    async (refundRequestId: string, _bookingId: string) => {
      return state.refundAmounts?.[refundRequestId] ?? null
    },
  )

  return {
    loadBooking: async (booking_id: string) => {
      return state.bookings?.[booking_id] ?? null
    },
    isAlreadySent: async (
      booking_id: string,
      type: NotificationType,
      channel: NotificationChannel,
      referenceId?: string | null,
    ) => {
      return (
        state.existingLog?.some(
          (e) =>
            e.booking_id === booking_id &&
            e.notification_type === type &&
            (e.channel ?? 'email') === channel &&
            e.status === 'sent' &&
            // Mirrors the EF: a reference id narrows the key; without one
            // the match stays booking-level.
            (!referenceId || e.reference_id === referenceId)
        ) ?? false
      )
    },
    writeLog: writeLogMock,
    sendEmail: sendEmailMock,
    sendSMS: sendSMSMock,
    loadNotificationLog: async (id: string) => {
      return state.queuedLogs?.[id] ?? null
    },
    updateLogStatus: updateLogStatusMock,
    loadRefundAmountCents: loadRefundAmountCentsMock,
    appUrl: 'https://verco.test',
    defaultFromEmail: 'noreply@verco.test',
    writtenLogs,
    writeLogMock,
    sendEmailMock,
    sendSMSMock,
    updateLogStatusMock,
    loadRefundAmountCentsMock,
  }
}
