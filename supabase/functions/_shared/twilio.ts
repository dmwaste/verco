/**
 * Twilio Programmable Messaging helper (v2010 Messages API, basic auth).
 * Reusable across Edge Functions for SMS dispatch.
 *
 * Requires Supabase secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN.
 *
 * Sender identity is per-tenant via Messaging Service SID (looked up on
 * the `client` row at `twilio_messaging_service_sid` — see
 * `_shared/dispatch.ts` for the routing). One Messaging Service per
 * registered alpha sender ID, all under a single D&M Twilio account.
 *
 * Never throws — all failure modes are encoded in `SendSMSResult`.
 */

interface SendSMSParams {
  /** Recipient phone number in E.164 format (e.g. `+61412345678`). */
  to: string
  /** Plain-text body. Twilio segments at 160 GSM-7 chars / 70 UCS-2 chars. */
  body: string
  /** Messaging Service SID (`MG…`) — determines the alpha sender used. */
  messagingServiceSid: string
}

interface SendSMSResult {
  ok: boolean
  /** Twilio Message SID (`SM…`) on success — used for downstream lookup. */
  messageSid?: string
  /** Status as returned by Twilio (`queued`, `accepted`, etc.) on success. */
  status?: string
  error?: string
}

export async function sendSMS(params: SendSMSParams): Promise<SendSMSResult> {
  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID')
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN')

  if (!accountSid || !authToken) {
    console.warn('TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not configured — skipping SMS')
    return { ok: false, error: 'Twilio credentials not configured' }
  }

  // The v2010 Messages endpoint takes form-encoded body, not JSON.
  const formBody = new URLSearchParams({
    To: params.to,
    Body: params.body,
    MessagingServiceSid: params.messagingServiceSid,
  })

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
        },
        body: formBody.toString(),
      },
    )

    if (res.status === 201) {
      const data = (await res.json()) as {
        sid?: string
        status?: string
      }
      return { ok: true, messageSid: data.sid, status: data.status }
    }

    // Twilio returns structured error JSON on 4xx/5xx. Surface the message
    // so notification_log captures something actionable.
    const errorBody = await res.text()
    console.error('Twilio send error:', res.status, errorBody)
    let parsed: { code?: number; message?: string } = {}
    try {
      parsed = JSON.parse(errorBody)
    } catch {
      // non-JSON body — fall through with raw text
    }
    const errorSummary = parsed.message
      ? `Twilio API error: ${parsed.code ?? res.status} — ${parsed.message}`
      : `Twilio API error: ${res.status} — ${errorBody}`
    return { ok: false, error: errorSummary }
  } catch (err) {
    console.error('Twilio send exception:', err)
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
