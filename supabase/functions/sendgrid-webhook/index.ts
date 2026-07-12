import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database, TablesUpdate } from '../_shared/database.types.ts'
import { sendgridEventToStatus, shouldApplyDeliveryStatus, type DeliveryStatus } from '../_shared/sendgrid-events.ts'

/**
 * SendGrid Event Webhook — bounce/spam/delivery visibility for UAT (VER-188).
 *
 * Public endpoint (deploy --no-verify-jwt). Security boundary = the SendGrid Signed Event
 * Webhook (ECDSA P-256). Fails CLOSED when the verification key isn't configured.
 *
 * Writes `notification_log.delivery_status` (NOT `status` — that's the send lifecycle the
 * re-send guard reads). Correlation is by recipient address (most-recent email row): precise
 * enough for UAT "is this address bouncing?" visibility. Precise per-message correlation
 * (a custom_arg / message-id threaded through send-notification) is a follow-up.
 *
 * Deploy AFTER the migration that adds delivery_status / delivery_updated_at / delivery_detail.
 */

// SendGrid Signed Event Webhook headers
const SIG_HEADER = 'x-twilio-email-event-webhook-signature'
const TS_HEADER = 'x-twilio-email-event-webhook-timestamp'

interface SendgridEvent {
  event: string
  email: string
  reason?: string
}

serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const verificationKey = Deno.env.get('SENDGRID_WEBHOOK_VERIFICATION_KEY')
  if (!verificationKey) {
    // A public webhook must not process unsigned events. Fail closed until the key is set.
    console.error('sendgrid-webhook: SENDGRID_WEBHOOK_VERIFICATION_KEY not configured')
    return new Response('Webhook not configured', { status: 503 })
  }

  const signature = req.headers.get(SIG_HEADER)
  const timestamp = req.headers.get(TS_HEADER)
  const rawBody = await req.text()

  if (!signature || !timestamp) {
    return new Response('Missing signature headers', { status: 401 })
  }
  if (!(await verifySignature(verificationKey, timestamp, rawBody, signature))) {
    return new Response('Invalid signature', { status: 401 })
  }

  let events: SendgridEvent[]
  try {
    const parsed = JSON.parse(rawBody)
    if (!Array.isArray(parsed)) throw new Error('payload is not an array')
    events = parsed
  } catch (err) {
    console.error('sendgrid-webhook: bad payload:', err)
    return new Response('Bad payload', { status: 400 })
  }

  const supabase = createClient<Database>(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Per-event failures are logged but never fail the batch — a non-2xx makes SendGrid retry
  // the WHOLE batch, re-applying already-handled events. Always 200 once the signature is valid.
  let applied = 0
  for (const ev of events) {
    const status = sendgridEventToStatus(ev.event)
    if (!status || !ev.email) continue
    try {
      if (await applyDeliveryStatus(supabase, ev.email, status, ev.reason ?? null)) applied++
    } catch (err) {
      console.error(`sendgrid-webhook: failed ${ev.event} for ${ev.email}:`, err)
    }
  }

  console.log(`sendgrid-webhook: ${events.length} events, ${applied} log rows updated`)
  return new Response(JSON.stringify({ received: events.length, applied }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})

/** Apply a delivery status to the most-recent email notification_log row for `email` (rank-guarded). */
async function applyDeliveryStatus(
  supabase: ReturnType<typeof createClient<Database>>,
  email: string,
  next: DeliveryStatus,
  reason: string | null,
): Promise<boolean> {
  const { data: row } = await supabase
    .from('notification_log')
    .select('id, delivery_status')
    .eq('to_address', email)
    .eq('channel', 'email')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!row) return false // no matching notification to annotate

  const current = (row.delivery_status as DeliveryStatus | null) ?? null
  if (!shouldApplyDeliveryStatus(current, next)) return false

  const update: TablesUpdate<'notification_log'> = {
    delivery_status: next,
    delivery_updated_at: new Date().toISOString(),
  }
  if (reason) update.delivery_detail = reason

  const { error } = await supabase.from('notification_log').update(update).eq('id', row.id)
  if (error) throw new Error(error.message)
  return true
}

// ── ECDSA P-256 signature verification (SendGrid Signed Event Webhook) ────────
// SendGrid signs `timestamp + rawBody` with ECDSA P-256 / SHA-256. The signature header is
// base64 ASN.1-DER; Web Crypto verify() wants raw r||s, so we convert.

async function verifySignature(publicKeyB64: string, timestamp: string, body: string, signatureB64: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      base64ToBytes(publicKeyB64),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const sigRaw = derToRawEcdsa(base64ToBytes(signatureB64))
    const data = new TextEncoder().encode(timestamp + body)
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sigRaw, data)
  } catch (err) {
    console.error('sendgrid-webhook: signature verify error:', err)
    return false
  }
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** ASN.1-DER ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }) → raw r||s (64 bytes for P-256). */
function derToRawEcdsa(der: Uint8Array): Uint8Array<ArrayBuffer> {
  if (der[0] !== 0x30) throw new Error('bad DER: no SEQUENCE')
  let offset = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2
  if (der[offset] !== 0x02) throw new Error('bad DER: no INTEGER r')
  const rLen = der[offset + 1]
  const r = der.slice(offset + 2, offset + 2 + rLen)
  offset = offset + 2 + rLen
  if (der[offset] !== 0x02) throw new Error('bad DER: no INTEGER s')
  const sLen = der[offset + 1]
  const s = der.slice(offset + 2, offset + 2 + sLen)
  const out = new Uint8Array(64)
  const rt = stripLeadingZeros(r)
  const st = stripLeadingZeros(s)
  if (rt.length > 32 || st.length > 32) throw new Error('integer longer than 32 bytes')
  out.set(rt, 32 - rt.length)
  out.set(st, 64 - st.length)
  return out
}

function stripLeadingZeros(b: Uint8Array): Uint8Array {
  let start = 0
  while (start < b.length - 1 && b[start] === 0x00) start++
  return b.slice(start)
}
