import { describe, it, expect, beforeEach, vi } from 'vitest'
import { dispatch } from '@/lib/notifications/dispatch'
import {
  createMockDispatchDeps,
  makeMockBooking,
} from './fixtures'

describe('dispatch', () => {
  // Silence the structured console.log emitted by dispatch during tests —
  // the log output itself is verified in a dedicated test below.
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  describe('idempotency', () => {
    it('short-circuits with {ok:true,skipped:true} when a sent row already exists', async () => {
      const booking = makeMockBooking({ id: 'b1' })
      const deps = createMockDispatchDeps({
        bookings: { b1: booking },
        existingLog: [
          {
            booking_id: 'b1',
            notification_type: 'booking_created',
            status: 'sent',
          },
        ],
      })

      const result = await dispatch(deps, {
        type: 'booking_created',
        booking_id: 'b1',
      })

      expect(result).toEqual({ ok: true, skipped: true })
      expect(deps.sendEmailMock).not.toHaveBeenCalled()
      expect(deps.writtenLogs).toHaveLength(0)
    })

    it('does NOT suppress a second per-stream NCN on the same booking (per-notice key)', async () => {
      // Stop model: green crew NCNs the green stop, general crew NCNs the
      // general stop hours later — same booking, same type, different ncn_id.
      // The old (booking, type, channel) key silently dropped the second
      // notice while its 14-day dispute window ran.
      const booking = makeMockBooking({ id: 'b-streams' })
      const deps = createMockDispatchDeps({
        bookings: { 'b-streams': booking },
        existingLog: [
          {
            booking_id: 'b-streams',
            notification_type: 'ncn_raised',
            status: 'sent',
            reference_id: 'ncn-green',
          },
        ],
      })

      const result = await dispatch(deps, {
        type: 'ncn_raised',
        booking_id: 'b-streams',
        ncn_id: 'ncn-general',
        reason: 'Building Waste',
      })

      expect(result.ok).toBe(true)
      expect('skipped' in result).toBe(false)
      expect(deps.sendEmailMock).toHaveBeenCalledTimes(1)
      // The new log row carries its own notice id for future dedupe
      expect(deps.writtenLogs[0]?.reference_id).toBe('ncn-general')
    })

    it('DOES skip a true duplicate of the same notice (same ncn_id)', async () => {
      const booking = makeMockBooking({ id: 'b-dup' })
      const deps = createMockDispatchDeps({
        bookings: { 'b-dup': booking },
        existingLog: [
          {
            booking_id: 'b-dup',
            notification_type: 'ncn_raised',
            status: 'sent',
            reference_id: 'ncn-1',
          },
        ],
      })

      const result = await dispatch(deps, {
        type: 'ncn_raised',
        booking_id: 'b-dup',
        ncn_id: 'ncn-1',
        reason: 'Building Waste',
      })

      expect(result).toEqual({ ok: true, skipped: true })
      expect(deps.sendEmailMock).not.toHaveBeenCalled()
    })

    it('does NOT skip when a prior failed row exists for the same booking+type', async () => {
      const booking = makeMockBooking({ id: 'b2' })
      const deps = createMockDispatchDeps({
        bookings: { b2: booking },
        existingLog: [
          {
            booking_id: 'b2',
            notification_type: 'booking_created',
            status: 'failed',
          },
        ],
      })

      const result = await dispatch(deps, {
        type: 'booking_created',
        booking_id: 'b2',
      })

      expect(result.ok).toBe(true)
      expect(deps.sendEmailMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('Illegal Dumping guard', () => {
    // ID collections carry the logging staff member as their contact, not a
    // resident — so no resident-facing notification (reminder/survey/NCN/NP)
    // may go out. The guard skips before either channel or any log write.
    it('skips resident notifications for an Illegal Dumping booking', async () => {
      const booking = makeMockBooking({ id: 'b-id', type: 'Illegal Dumping' })
      const deps = createMockDispatchDeps({ bookings: { 'b-id': booking } })

      const result = await dispatch(deps, {
        type: 'collection_reminder',
        booking_id: 'b-id',
      })

      expect(result).toEqual({ ok: true, skipped: true })
      expect(deps.sendEmailMock).not.toHaveBeenCalled()
      expect(deps.sendSMSMock).not.toHaveBeenCalled()
      expect(deps.writtenLogs).toHaveLength(0)
    })
  })

  describe('booking-not-found short-circuit', () => {
    it('returns a clean error without writing to notification_log', async () => {
      const deps = createMockDispatchDeps({ bookings: {} })

      const result = await dispatch(deps, {
        type: 'booking_created',
        booking_id: 'does-not-exist',
      })

      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toContain('does-not-exist')
      }
      expect(deps.writtenLogs).toHaveLength(0)
      expect(deps.sendEmailMock).not.toHaveBeenCalled()
    })
  })

  describe('missing contact email', () => {
    it('writes a failed log row and does not call sendEmail', async () => {
      const booking = makeMockBooking({ id: 'b3', contact: null })
      const deps = createMockDispatchDeps({ bookings: { b3: booking } })

      const result = await dispatch(deps, {
        type: 'booking_created',
        booking_id: 'b3',
      })

      expect(result.ok).toBe(false)
      expect(deps.sendEmailMock).not.toHaveBeenCalled()
      expect(deps.writtenLogs).toHaveLength(1)
      expect(deps.writtenLogs[0]!.status).toBe('failed')
      expect(deps.writtenLogs[0]!.client_id).toBe(booking.client_id)
    })
  })

  describe('happy path', () => {
    it('renders template, sends email, writes sent log row, returns ok+sent', async () => {
      const booking = makeMockBooking({ id: 'b4', ref: 'VV-HAPPY' })
      const deps = createMockDispatchDeps({ bookings: { b4: booking } })

      const result = await dispatch(deps, {
        type: 'booking_created',
        booking_id: 'b4',
      })

      expect(result.ok).toBe(true)
      if (result.ok === true && 'sent' in result) {
        expect(result.sent).toBe(true)
      }
      expect(deps.sendEmailMock).toHaveBeenCalledTimes(1)
      const call = deps.sendEmailMock.mock.calls[0]![0]
      expect(call.to.email).toBe(booking.contact!.email)
      expect(call.subject).toContain('VV-HAPPY')
      expect(call.htmlBody).toContain('VV-HAPPY')
      expect(deps.writtenLogs).toHaveLength(1)
      expect(deps.writtenLogs[0]!.status).toBe('sent')
    })

    it('uses client reply_to_email and email_from_name when set', async () => {
      const booking = makeMockBooking({
        id: 'b5',
        client: {
          slug: 'kwn',
          custom_domain: null,
          name: 'City of Kwinana',
          logo_light_url: null,
          primary_colour: null,
          email_footer_html: null,
          reply_to_email: 'verge@kwinana.wa.gov.au',
          email_from_name: 'City of Kwinana — Verge Collection',
          twilio_messaging_service_sid: null,
        },
      })
      const deps = createMockDispatchDeps({ bookings: { b5: booking } })

      await dispatch(deps, { type: 'booking_created', booking_id: 'b5' })

      const call = deps.sendEmailMock.mock.calls[0]![0]
      expect(call.from.email).toBe('verge@kwinana.wa.gov.au')
      expect(call.from.name).toBe('City of Kwinana — Verge Collection')
    })

    it('falls back to defaultFromEmail and client name when the client has no reply_to_email', async () => {
      const booking = makeMockBooking({
        id: 'b6',
        client: {
          slug: 'bare',
          custom_domain: null,
          name: 'Bare Council',
          logo_light_url: null,
          primary_colour: null,
          email_footer_html: null,
          reply_to_email: null,
          email_from_name: null,
          twilio_messaging_service_sid: null,
        },
      })
      const deps = createMockDispatchDeps({ bookings: { b6: booking } })

      await dispatch(deps, { type: 'booking_created', booking_id: 'b6' })

      const call = deps.sendEmailMock.mock.calls[0]![0]
      expect(call.from.email).toBe('noreply@verco.test')
      expect(call.from.name).toBe('Bare Council')
    })
  })

  describe('sendEmail failure', () => {
    it('writes a failed log row and returns {ok:false,error}', async () => {
      const booking = makeMockBooking({ id: 'b7' })
      const deps = createMockDispatchDeps({
        bookings: { b7: booking },
        sendResult: { ok: false, error: 'SendGrid 502', status: 502 },
      })

      const result = await dispatch(deps, {
        type: 'booking_created',
        booking_id: 'b7',
      })

      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toBe('SendGrid 502')
      }
      expect(deps.writtenLogs).toHaveLength(1)
      expect(deps.writtenLogs[0]!.status).toBe('failed')
      expect(deps.writtenLogs[0]!.error_message).toBe('SendGrid 502')
    })
  })

  describe('booking_cancelled', () => {
    it('dispatches via the booking-cancelled template with the reason passed through', async () => {
      const booking = makeMockBooking({ id: 'b8' })
      const deps = createMockDispatchDeps({ bookings: { b8: booking } })

      await dispatch(deps, {
        type: 'booking_cancelled',
        booking_id: 'b8',
        reason: 'Contractor broke down',
      })

      expect(deps.sendEmailMock).toHaveBeenCalledTimes(1)
      const call = deps.sendEmailMock.mock.calls[0]![0]
      expect(call.subject).toContain('Booking cancelled')
      expect(call.htmlBody).toContain('Contractor broke down')
    })

    it('forwards refund_status to booking_cancelled template', async () => {
      const booking = makeMockBooking({ id: 'b-refund', total_charge_cents: 5500 })
      const deps = createMockDispatchDeps({ bookings: { 'b-refund': booking } })

      const result = await dispatch(deps, {
        type: 'booking_cancelled',
        booking_id: 'b-refund',
        refund_status: 'pending_review',
      })

      expect(result).toMatchObject({ ok: true, sent: true })
      // Verify the email body contains the "pending review" copy
      const emailCall = deps.sendEmailMock.mock.calls[0]?.[0] as { htmlBody: string } | undefined
      expect(emailCall?.htmlBody).toContain('reviewed by our team')
      expect(emailCall?.htmlBody).not.toContain('has been processed')
    })
  })

  it('routes ncn_raised to the NCN template with payload fields', async () => {
    const booking = makeMockBooking({ id: 'b-ncn' })
    const deps = createMockDispatchDeps({ bookings: { 'b-ncn': booking } })

    const result = await dispatch(deps, {
      type: 'ncn_raised',
      booking_id: 'b-ncn',
      ncn_id: 'ncn-1',
      reason: 'Building Waste',
      notes: 'Behind the fence',
    })

    expect(result).toMatchObject({ ok: true, sent: true })
    const emailCall = deps.sendEmailMock.mock.calls[0]?.[0] as { subject: string; htmlBody: string } | undefined
    expect(emailCall?.subject).toContain('Non-conformance notice')
    expect(emailCall?.htmlBody).toContain('Building Waste')
    expect(emailCall?.htmlBody).toContain('Behind the fence')
  })

  it('routes np_raised to the NP template with payload fields', async () => {
    const booking = makeMockBooking({ id: 'b-np' })
    const deps = createMockDispatchDeps({ bookings: { 'b-np': booking } })

    const result = await dispatch(deps, {
      type: 'np_raised',
      booking_id: 'b-np',
      np_id: 'np-1',
      contractor_fault: true,
    })

    expect(result).toMatchObject({ ok: true, sent: true })
    const emailCall = deps.sendEmailMock.mock.calls[0]?.[0] as { subject: string; htmlBody: string } | undefined
    expect(emailCall?.subject).toContain('Nothing presented')
    expect(emailCall?.htmlBody).toContain('unable to attend')
  })

  // A4 envelope-boundary regression: the `stream` wire key carries the booked
  // service label and the dispatcher maps it onto the template's `serviceLabel`
  // option. A missed mapping in either branch silently drops the row.
  it('threads the stream payload into the ncn email as a Service type row', async () => {
    const booking = makeMockBooking({ id: 'b-ncn-svc' })
    const deps = createMockDispatchDeps({ bookings: { 'b-ncn-svc': booking } })

    const result = await dispatch(deps, {
      type: 'ncn_raised',
      booking_id: 'b-ncn-svc',
      ncn_id: 'ncn-svc',
      reason: 'Building Waste',
      stream: 'E-Waste, Mattress',
    })

    expect(result).toMatchObject({ ok: true, sent: true })
    const emailCall = deps.sendEmailMock.mock.calls[0]?.[0] as { htmlBody: string } | undefined
    expect(emailCall?.htmlBody).toContain('Service type')
    expect(emailCall?.htmlBody).toContain('E-Waste, Mattress')
  })

  it('drops non-storage photo URLs at the dispatch trust boundary, keeps genuine ones', async () => {
    // The EF accepts payload.photos from any permitted-role JWT; the capture
    // layers validate the storage prefix, but dispatch must not trust that.
    const booking = makeMockBooking({ id: 'b-ncn-photos' })
    const deps = createMockDispatchDeps({ bookings: { 'b-ncn-photos': booking } })

    await dispatch(deps, {
      type: 'ncn_raised',
      booking_id: 'b-ncn-photos',
      ncn_id: 'ncn-photos',
      reason: 'Building Waste',
      photos: [
        'https://proj.supabase.co/storage/v1/object/public/closeout/genuine.jpg',
        'https://evil.example.com/phish.jpg',
        'javascript:alert(1)',
      ],
    })

    const emailCall = deps.sendEmailMock.mock.calls[0]?.[0] as { htmlBody: string } | undefined
    expect(emailCall?.htmlBody).toContain('closeout/genuine.jpg')
    expect(emailCall?.htmlBody).not.toContain('evil.example.com')
    expect(emailCall?.htmlBody).not.toContain('javascript:alert(1)')
  })

  it('threads the stream payload into the np email as a Service type row', async () => {
    const booking = makeMockBooking({ id: 'b-np-svc' })
    const deps = createMockDispatchDeps({ bookings: { 'b-np-svc': booking } })

    const result = await dispatch(deps, {
      type: 'np_raised',
      booking_id: 'b-np-svc',
      np_id: 'np-svc',
      stream: 'Bulk Waste',
    })

    expect(result).toMatchObject({ ok: true, sent: true })
    const emailCall = deps.sendEmailMock.mock.calls[0]?.[0] as { htmlBody: string } | undefined
    expect(emailCall?.htmlBody).toContain('Service type')
    expect(emailCall?.htmlBody).toContain('Bulk Waste')
  })

  it('routes payment_reminder to the reminder template', async () => {
    const booking = makeMockBooking({ id: 'b-remind', total_charge_cents: 5500 })
    const deps = createMockDispatchDeps({ bookings: { 'b-remind': booking } })

    const result = await dispatch(deps, {
      type: 'payment_reminder',
      booking_id: 'b-remind',
    })

    expect(result).toMatchObject({ ok: true, sent: true })
    const emailCall = deps.sendEmailMock.mock.calls[0]?.[0] as { subject: string; htmlBody: string } | undefined
    expect(emailCall?.subject).toContain('Complete your booking')
    expect(emailCall?.htmlBody).toContain('$55.00')
  })

  it('routes payment_expired to the expired template', async () => {
    const booking = makeMockBooking({ id: 'b-expire', total_charge_cents: 5500 })
    const deps = createMockDispatchDeps({ bookings: { 'b-expire': booking } })

    const result = await dispatch(deps, {
      type: 'payment_expired',
      booking_id: 'b-expire',
    })

    expect(result).toMatchObject({ ok: true, sent: true })
    const emailCall = deps.sendEmailMock.mock.calls[0]?.[0] as { subject: string; htmlBody: string } | undefined
    expect(emailCall?.subject).toContain('Booking expired')
    expect(emailCall?.htmlBody).toContain('No charge has been made')
  })

  it('routes completion_survey to the survey template with token in CTA', async () => {
    const booking = makeMockBooking({ id: 'b-survey' })
    const deps = createMockDispatchDeps({ bookings: { 'b-survey': booking } })

    const result = await dispatch(deps, {
      type: 'completion_survey',
      booking_id: 'b-survey',
      survey_token: 'tok-xyz',
    })

    expect(result).toMatchObject({ ok: true, sent: true })
    const emailCall = deps.sendEmailMock.mock.calls[0]?.[0] as { subject: string; htmlBody: string } | undefined
    expect(emailCall?.subject).toContain('How was your collection')
    expect(emailCall?.htmlBody).toContain('tok-xyz')
    expect(emailCall?.htmlBody).toContain('Complete survey')
  })

  describe('resume-by-log-id', () => {
    it('resumes a queued log row, sends email, and calls updateLogStatus with sent', async () => {
      const booking = makeMockBooking({ id: 'b-resume', total_charge_cents: 5500 })
      const deps = createMockDispatchDeps({
        bookings: { 'b-resume': booking },
        queuedLogs: {
          'log-queued-1': {
            booking_id: 'b-resume',
            notification_type: 'booking_cancelled',
            status: 'queued',
            to_address: 'pending',
          },
        },
      })

      const result = await dispatch(deps, { notification_log_id: 'log-queued-1' })

      expect(result).toMatchObject({ ok: true, sent: true })
      expect(deps.sendEmailMock).toHaveBeenCalledTimes(1)
      expect(deps.updateLogStatusMock).toHaveBeenCalledWith(
        'log-queued-1',
        'sent',
        undefined,
        booking.contact!.email
      )
    })

    it('returns error when log row is not found', async () => {
      const deps = createMockDispatchDeps({})

      const result = await dispatch(deps, { notification_log_id: 'nonexistent' })

      expect(result).toMatchObject({ ok: false })
      expect(result.ok === false && result.error).toContain('not found')
      expect(deps.sendEmailMock).not.toHaveBeenCalled()
    })

    it('skips when log row is already sent', async () => {
      const deps = createMockDispatchDeps({
        queuedLogs: {
          'log-already-sent': {
            booking_id: 'b-any',
            notification_type: 'booking_cancelled',
            status: 'sent',
            to_address: 'test@example.com',
          },
        },
      })

      const result = await dispatch(deps, { notification_log_id: 'log-already-sent' })

      expect(result).toEqual({ ok: true, skipped: true })
      expect(deps.sendEmailMock).not.toHaveBeenCalled()
    })

    it('rejects resume for ncn_raised — requires payload fields not stored in log', async () => {
      const booking = makeMockBooking({ id: 'b-ncn-resume' })
      const deps = createMockDispatchDeps({
        bookings: { 'b-ncn-resume': booking },
        queuedLogs: {
          'log-ncn': {
            booking_id: 'b-ncn-resume',
            notification_type: 'ncn_raised',
            status: 'queued',
            to_address: 'pending',
          },
        },
      })

      const result = await dispatch(deps, { notification_log_id: 'log-ncn' })

      expect(result).toMatchObject({ ok: false })
      expect(result.ok === false && result.error).toContain('Cannot resume')
      expect(deps.sendEmailMock).not.toHaveBeenCalled()
    })

    it('rejects resume for completion_survey — requires survey_token', async () => {
      const booking = makeMockBooking({ id: 'b-survey-resume' })
      const deps = createMockDispatchDeps({
        bookings: { 'b-survey-resume': booking },
        queuedLogs: {
          'log-survey': {
            booking_id: 'b-survey-resume',
            notification_type: 'completion_survey',
            status: 'queued',
            to_address: 'pending',
          },
        },
      })

      const result = await dispatch(deps, { notification_log_id: 'log-survey' })

      expect(result).toMatchObject({ ok: false })
      expect(result.ok === false && result.error).toContain('Cannot resume')
      expect(deps.sendEmailMock).not.toHaveBeenCalled()
    })
  })

  describe('sms dispatch', () => {
    const smsClient = {
      slug: 'kwn',
      custom_domain: null,
      name: 'City of Kwinana',
      logo_light_url: null,
      primary_colour: null,
      email_footer_html: null,
      reply_to_email: null,
      email_from_name: null,
      twilio_messaging_service_sid: 'MG3247a987de2cd0b550904b7973305780',
    }

    it('sends SMS when contact has mobile, tenant has MG sid, and type has an SMS variant', async () => {
      const booking = makeMockBooking({
        id: 'b-sms-ok',
        ref: 'KWN-SMS01',
        client: smsClient,
      })
      const deps = createMockDispatchDeps({ bookings: { 'b-sms-ok': booking } })

      const result = await dispatch(deps, { type: 'booking_created', booking_id: 'b-sms-ok' })

      expect(result).toMatchObject({ ok: true, sent: true })
      expect(deps.sendSMSMock).toHaveBeenCalledTimes(1)
      const call = deps.sendSMSMock.mock.calls[0]![0]
      expect(call.to).toBe(booking.contact!.mobile_e164)
      expect(call.messagingServiceSid).toBe(smsClient.twilio_messaging_service_sid)
      expect(call.body).toContain('KWN-SMS01')
      expect(call.body).toContain('verco.au/b/KWN-SMS01')

      // Both an email and an SMS log row should exist
      const emailLog = deps.writtenLogs.find((r) => r.channel === 'email')
      const smsLog = deps.writtenLogs.find((r) => r.channel === 'sms')
      expect(emailLog).toBeDefined()
      expect(emailLog!.status).toBe('sent')
      expect(smsLog).toBeDefined()
      expect(smsLog!.status).toBe('sent')
      expect(smsLog!.to_address).toBe(booking.contact!.mobile_e164)
    })

    it('skips SMS when the contact has no mobile_e164', async () => {
      const booking = makeMockBooking({
        id: 'b-no-mob',
        client: smsClient,
        contact: {
          id: 'contact-no-mob',
          full_name: 'No Mobile',
          email: 'nomob@example.test',
          mobile_e164: null,
        },
      })
      const deps = createMockDispatchDeps({ bookings: { 'b-no-mob': booking } })

      await dispatch(deps, { type: 'booking_created', booking_id: 'b-no-mob' })

      expect(deps.sendSMSMock).not.toHaveBeenCalled()
      expect(deps.writtenLogs.some((r) => r.channel === 'sms')).toBe(false)
    })

    it('skips SMS when tenant has no twilio_messaging_service_sid', async () => {
      // Default fixture client has twilio_messaging_service_sid: null
      const booking = makeMockBooking({ id: 'b-no-sid' })
      const deps = createMockDispatchDeps({ bookings: { 'b-no-sid': booking } })

      await dispatch(deps, { type: 'booking_created', booking_id: 'b-no-sid' })

      expect(deps.sendSMSMock).not.toHaveBeenCalled()
      expect(deps.writtenLogs.some((r) => r.channel === 'sms')).toBe(false)
    })

    it('skips SMS for notification types without an SMS variant (e.g. booking_cancelled)', async () => {
      const booking = makeMockBooking({
        id: 'b-cancel',
        client: smsClient,
      })
      const deps = createMockDispatchDeps({ bookings: { 'b-cancel': booking } })

      await dispatch(deps, { type: 'booking_cancelled', booking_id: 'b-cancel' })

      expect(deps.sendSMSMock).not.toHaveBeenCalled()
      expect(deps.writtenLogs.some((r) => r.channel === 'sms')).toBe(false)
    })

    it('still attempts SMS when email channel is already sent (per-channel independence)', async () => {
      // Regression: previously the email-channel idempotency check returned
      // early with {ok:true,skipped:true} BEFORE dispatchSms() ran, which
      // meant a successful email permanently blocked the SMS for the same
      // notification. This breaks per-channel `(booking_id, type, channel)`
      // idempotency. The dispatcher must fall through to SMS even when
      // email is being skipped.
      const booking = makeMockBooking({
        id: 'b-email-already',
        client: smsClient,
      })
      const deps = createMockDispatchDeps({
        bookings: { 'b-email-already': booking },
        existingLog: [
          {
            booking_id: 'b-email-already',
            notification_type: 'booking_created',
            channel: 'email',
            status: 'sent',
          },
        ],
      })

      const result = await dispatch(deps, { type: 'booking_created', booking_id: 'b-email-already' })

      // Email reports skipped — that's the headline DispatchResult
      expect(result).toEqual({ ok: true, skipped: true })
      expect(deps.sendEmailMock).not.toHaveBeenCalled()

      // BUT SMS must still have fired
      expect(deps.sendSMSMock).toHaveBeenCalledTimes(1)
      const smsLog = deps.writtenLogs.find((r) => r.channel === 'sms')
      expect(smsLog).toBeDefined()
      expect(smsLog!.status).toBe('sent')
    })

    it('skips SMS when (booking_id, type, sms) already has a sent row, but still sends email', async () => {
      const booking = makeMockBooking({
        id: 'b-sms-dupe',
        client: smsClient,
      })
      const deps = createMockDispatchDeps({
        bookings: { 'b-sms-dupe': booking },
        existingLog: [
          {
            booking_id: 'b-sms-dupe',
            notification_type: 'booking_created',
            channel: 'sms',
            status: 'sent',
          },
        ],
      })

      const result = await dispatch(deps, { type: 'booking_created', booking_id: 'b-sms-dupe' })

      expect(result).toMatchObject({ ok: true, sent: true })
      expect(deps.sendEmailMock).toHaveBeenCalledTimes(1)
      expect(deps.sendSMSMock).not.toHaveBeenCalled()
    })

    it('records a failed SMS log row when Twilio rejects, but does NOT fail the email DispatchResult', async () => {
      const booking = makeMockBooking({
        id: 'b-sms-fail',
        client: smsClient,
      })
      const deps = createMockDispatchDeps({
        bookings: { 'b-sms-fail': booking },
        smsResult: { ok: false, error: 'Twilio 400: invalid number' },
      })

      const result = await dispatch(deps, { type: 'booking_created', booking_id: 'b-sms-fail' })

      // Email succeeded — the SMS failure must not propagate
      expect(result).toMatchObject({ ok: true, sent: true })
      const smsLog = deps.writtenLogs.find((r) => r.channel === 'sms')
      expect(smsLog).toBeDefined()
      expect(smsLog!.status).toBe('failed')
      expect(smsLog!.error_message).toContain('Twilio 400')
    })
  })

  describe('structured logging contract', () => {
    it('emits one JSON log line per dispatch with the required fields', async () => {
      const logSpy = vi.spyOn(console, 'log')
      const booking = makeMockBooking({ id: 'b9' })
      const deps = createMockDispatchDeps({ bookings: { b9: booking } })

      await dispatch(deps, { type: 'booking_created', booking_id: 'b9' })

      expect(logSpy).toHaveBeenCalledTimes(1)
      const [line] = logSpy.mock.calls[0]!
      const parsed = JSON.parse(line as string)
      expect(parsed).toMatchObject({
        event: 'notification_dispatch',
        booking_id: 'b9',
        type: 'booking_created',
        status: 'sent',
        sendgrid_status: 202,
      })
      expect(typeof parsed.duration_ms).toBe('number')
    })
  })
})
