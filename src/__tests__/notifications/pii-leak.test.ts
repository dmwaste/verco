import { describe, it, expect, beforeEach, vi } from 'vitest'
import { dispatch } from '@/lib/notifications/dispatch'
import {
  createMockDispatchDeps,
  makePiiLoadedBooking,
  PII_STRINGS,
} from './fixtures'

/**
 * PII regression test — activated in Phase 1 (VER-119) per the tech review
 * note on VER-118.
 *
 * ## What this catches
 *
 * Someone adds a contact field to a field-accessible template path six
 * months from now, and the PII contract from CLAUDE.md §4 silently breaks.
 * A pure-function unit test on templates won't catch it if the template is
 * written with the PII field in the body; only an integration-level check
 * of the rendered HTML can guarantee none of the 3 PII values leak through.
 *
 * ## What it does NOT cover
 *
 *   1. Whether the DB RLS denies field users from selecting contacts
 *      directly — that's covered by `rls.test.ts`
 *   2. Whether the EF auth layer accepts/rejects field users — that's
 *      covered by smoke testing Phase 1 staging
 *
 * This test is complementary: it guarantees the TEMPLATE-rendered HTML
 * does not mention contact PII, which is the single worst place a leak
 * could hide (because the HTML is sent directly to a human inbox).
 *
 * ## Extension for later types
 *
 * When Phase 3 lands ncn_raised/np_raised templates (VER-121), add cases
 * here that dispatch those types against a `makePiiLoadedBooking()` and
 * assert the same "no PII in HTML" invariant.
 */
describe('PII leak regression', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('booking_created template does not contain contact full_name, email, or mobile', async () => {
    const booking = makePiiLoadedBooking()
    const deps = createMockDispatchDeps({ bookings: { [booking.id]: booking } })

    await dispatch(deps, { type: 'booking_created', booking_id: booking.id })

    expect(deps.sendEmailMock).toHaveBeenCalledTimes(1)
    const call = deps.sendEmailMock.mock.calls[0]![0]
    const html: string = call.htmlBody

    // The 3 PII values live on the contact record and MUST NOT appear in
    // the rendered email body. (The contact email IS allowed as the `to`
    // address — that's its purpose — but it must not leak into htmlBody.)
    expect(html).not.toContain(PII_STRINGS.full_name)
    expect(html).not.toContain(PII_STRINGS.email)
    expect(html).not.toContain(PII_STRINGS.mobile_e164)
  })

  it('booking_cancelled template does not contain contact full_name, email, or mobile', async () => {
    const booking = makePiiLoadedBooking()
    const deps = createMockDispatchDeps({ bookings: { [booking.id]: booking } })

    await dispatch(deps, {
      type: 'booking_cancelled',
      booking_id: booking.id,
      reason: 'Test cancel reason',
    })

    const call = deps.sendEmailMock.mock.calls[0]![0]
    const html: string = call.htmlBody

    expect(html).not.toContain(PII_STRINGS.full_name)
    expect(html).not.toContain(PII_STRINGS.email)
    expect(html).not.toContain(PII_STRINGS.mobile_e164)
  })

  it('ncn_raised template does not contain contact full_name, email, or mobile', async () => {
    const booking = makePiiLoadedBooking()
    const deps = createMockDispatchDeps({ bookings: { [booking.id]: booking } })

    await dispatch(deps, {
      type: 'ncn_raised',
      booking_id: booking.id,
      ncn_id: 'ncn-pii-test',
      reason: 'Building Waste',
      notes: 'Test notes',
    })

    expect(deps.sendEmailMock).toHaveBeenCalledTimes(1)
    const call = deps.sendEmailMock.mock.calls[0]![0]
    const html: string = call.htmlBody

    expect(html).not.toContain(PII_STRINGS.full_name)
    expect(html).not.toContain(PII_STRINGS.email)
    expect(html).not.toContain(PII_STRINGS.mobile_e164)
  })

  it('np_raised template does not contain contact full_name, email, or mobile', async () => {
    const booking = makePiiLoadedBooking()
    const deps = createMockDispatchDeps({ bookings: { [booking.id]: booking } })

    await dispatch(deps, {
      type: 'np_raised',
      booking_id: booking.id,
      np_id: 'np-pii-test',
    })

    expect(deps.sendEmailMock).toHaveBeenCalledTimes(1)
    const call = deps.sendEmailMock.mock.calls[0]![0]
    const html: string = call.htmlBody

    expect(html).not.toContain(PII_STRINGS.full_name)
    expect(html).not.toContain(PII_STRINGS.email)
    expect(html).not.toContain(PII_STRINGS.mobile_e164)
  })

  it('completion_survey template does not contain contact full_name, email, or mobile', async () => {
    const booking = makePiiLoadedBooking()
    const deps = createMockDispatchDeps({ bookings: { [booking.id]: booking } })

    await dispatch(deps, {
      type: 'completion_survey',
      booking_id: booking.id,
      survey_token: 'tok-pii-test',
    })

    expect(deps.sendEmailMock).toHaveBeenCalledTimes(1)
    const call = deps.sendEmailMock.mock.calls[0]![0]
    const html: string = call.htmlBody

    expect(html).not.toContain(PII_STRINGS.full_name)
    expect(html).not.toContain(PII_STRINGS.email)
    expect(html).not.toContain(PII_STRINGS.mobile_e164)
  })

  it('closeout_corrected template does not contain contact full_name, email, or mobile', async () => {
    const booking = makePiiLoadedBooking()
    const deps = createMockDispatchDeps({ bookings: { [booking.id]: booking } })

    await dispatch(deps, {
      type: 'closeout_corrected',
      booking_id: booking.id,
      correction_id: 'corr-pii-test',
    })

    expect(deps.sendEmailMock).toHaveBeenCalledTimes(1)
    const html: string = deps.sendEmailMock.mock.calls[0]![0].htmlBody

    expect(html).not.toContain(PII_STRINGS.full_name)
    expect(html).not.toContain(PII_STRINGS.email)
    expect(html).not.toContain(PII_STRINGS.mobile_e164)
  })

  it('payment_reminder template does not contain contact full_name, email, or mobile', async () => {
    const booking = makePiiLoadedBooking()
    const deps = createMockDispatchDeps({ bookings: { [booking.id]: booking } })

    await dispatch(deps, {
      type: 'payment_reminder',
      booking_id: booking.id,
    })

    expect(deps.sendEmailMock).toHaveBeenCalledTimes(1)
    const call = deps.sendEmailMock.mock.calls[0]![0]
    const html: string = call.htmlBody

    expect(html).not.toContain(PII_STRINGS.full_name)
    expect(html).not.toContain(PII_STRINGS.email)
    expect(html).not.toContain(PII_STRINGS.mobile_e164)
  })

  it('payment_expired template does not contain contact full_name, email, or mobile', async () => {
    const booking = makePiiLoadedBooking()
    const deps = createMockDispatchDeps({ bookings: { [booking.id]: booking } })

    await dispatch(deps, {
      type: 'payment_expired',
      booking_id: booking.id,
    })

    expect(deps.sendEmailMock).toHaveBeenCalledTimes(1)
    const call = deps.sendEmailMock.mock.calls[0]![0]
    const html: string = call.htmlBody

    expect(html).not.toContain(PII_STRINGS.full_name)
    expect(html).not.toContain(PII_STRINGS.email)
    expect(html).not.toContain(PII_STRINGS.mobile_e164)
  })
})
