/**
 * Ops alert sink (#576) — the shared sender every watchdog EF alerts through.
 *
 * notification-health-check ran for three months with no webhook configured:
 * it detected problems, logged a warning nobody read and returned 200. These
 * tests pin the two halves of the fix: the Teams/Slack payload shapes, and that
 * every way an alert can fail to go out raises a Sentry warning instead of
 * disappearing.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ADMIN_ORIGIN,
  buildAdaptiveCard,
  buildOpsAlertPayload,
  buildTestAlert,
  formatAwst,
  isTestAlertRequest,
  MAX_LINE_LENGTH,
  opsAlertText,
  parseOpsAlertFormat,
  redactPii,
  redactUrls,
  resolveOpsAlertSink,
  sendOpsAlert,
  type OpsAlert,
  type OpsAlertConfig,
} from '@/lib/notifications/ops-alert'

// 20/10/2026 15:15 AWST
const NOW = new Date('2026-10-20T07:15:00.000Z')
// Fixture only — shaped like a Workflows trigger URL, signature included.
const WEBHOOK_URL =
  'https://default0000.00.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=FIXTURE-SIGNATURE'

const alert: OpsAlert = {
  source: 'notification-health-check',
  title: '🚨 Verco notification health alert',
  lines: ['1 channel(s) failing over the last 3h:', '', '• SMS — 4 failed sends', 'Check the Twilio dashboard.'],
  links: [{ label: 'Notification log', url: `${ADMIN_ORIGIN}/admin/notifications` }],
}

function okFetch(status = 202, body = '') {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch
}

function send(config: Partial<OpsAlertConfig>, fetchImpl: typeof fetch = okFetch(), a: OpsAlert = alert) {
  const captureWarning = vi.fn()
  const promise = sendOpsAlert(
    a,
    { webhookUrl: WEBHOOK_URL, format: undefined, ...config },
    { captureWarning, fetch: fetchImpl, now: NOW },
  )
  return { promise, captureWarning }
}

describe('parseOpsAlertFormat', () => {
  it('defaults to teams when unset or blank', () => {
    expect(parseOpsAlertFormat(undefined)).toBe('teams')
    expect(parseOpsAlertFormat(null)).toBe('teams')
    expect(parseOpsAlertFormat('  ')).toBe('teams')
  })

  it('accepts teams and slack, ignoring case and spaces', () => {
    expect(parseOpsAlertFormat('Teams ')).toBe('teams')
    expect(parseOpsAlertFormat('SLACK')).toBe('slack')
  })

  it('rejects anything else rather than guess', () => {
    expect(parseOpsAlertFormat('msteams')).toBeNull()
    expect(parseOpsAlertFormat('email')).toBeNull()
  })
})

describe('resolveOpsAlertSink', () => {
  it('resolves a set URL to the default teams format', () => {
    expect(resolveOpsAlertSink({ webhookUrl: ` ${WEBHOOK_URL} `, format: undefined })).toEqual({
      ok: true,
      webhookUrl: WEBHOOK_URL,
      format: 'teams',
    })
  })

  it('names the missing secret, and a bad format without echoing a URL', () => {
    expect(resolveOpsAlertSink({ webhookUrl: undefined, format: 'slack' })).toEqual({
      ok: false,
      reason: 'not_configured',
      error: 'OPS_ALERT_WEBHOOK_URL is not set',
    })
    const bad = resolveOpsAlertSink({ webhookUrl: WEBHOOK_URL, format: WEBHOOK_URL })
    expect(bad).toMatchObject({ ok: false, reason: 'invalid_format' })
    expect(JSON.stringify(bad)).not.toContain('FIXTURE-SIGNATURE')
  })
})

describe('buildOpsAlertPayload — teams', () => {
  const payload = buildOpsAlertPayload(alert, 'teams', NOW) as {
    type: string
    attachments: Array<{ contentType: string; contentUrl: null; content: Record<string, unknown> }>
  }

  it('uses the Workflows "When a Teams webhook request is received" envelope', () => {
    expect(payload.type).toBe('message')
    expect(payload.attachments).toHaveLength(1)
    expect(payload.attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive')
    expect(payload.attachments[0]!.contentUrl).toBeNull()
    expect(payload.attachments[0]!.content).toMatchObject({ type: 'AdaptiveCard', version: '1.4' })
  })

  // The text of a block: a RichTextBlock's single TextRun, or a TextBlock's text.
  const textOf = (b: Record<string, unknown>) =>
    b.type === 'RichTextBlock' ? (b.inlines as Array<{ text: string }>)[0]!.text : (b.text as string)

  it('renders title, lines and the AWST footer as plain text, links as one markdown TextBlock', () => {
    const body = buildAdaptiveCard(alert, NOW).body as Array<Record<string, unknown>>
    expect(body.map((b) => b.type)).toEqual(['RichTextBlock', 'RichTextBlock', 'RichTextBlock', 'RichTextBlock', 'TextBlock', 'RichTextBlock'])
    expect((body[0]!.inlines as unknown[])[0]).toMatchObject({
      type: 'TextRun',
      text: '🚨 Verco notification health alert',
      weight: 'Bolder',
      color: 'Attention',
    })
    const texts = body.map(textOf)
    expect(texts).toContain('• SMS — 4 failed sends')
    expect(texts).toContain(`[Notification log](${ADMIN_ORIGIN}/admin/notifications)`)
    expect(texts.at(-1)).toBe('Sent by notification-health-check · 20/10/2026 15:15 AWST')
  })

  it('turns a blank line into spacing, never an empty block', () => {
    const body = buildAdaptiveCard(alert, NOW).body as Array<Record<string, unknown>>
    expect(body.some((b) => textOf(b).trim() === '')).toBe(false)
    expect(body.find((b) => textOf(b) === '• SMS — 4 failed sends')).toMatchObject({ spacing: 'Medium' })
  })

  // TextBlock text is markdown in Teams: `_` turned refs into italics.
  it('keeps underscores and asterisks literal in alert lines (no markdown)', () => {
    const body = buildAdaptiveCard(
      { source: 'notification-health-check', title: 'no booking_created row', lines: ['• KWN-2-AB12_CD *paid*'] },
      NOW,
    ).body as Array<Record<string, unknown>>
    expect(body[0]!.type).toBe('RichTextBlock')
    expect(textOf(body[0]!)).toBe('no booking_created row')
    expect(body[1]).toMatchObject({ type: 'RichTextBlock', inlines: [{ type: 'TextRun', text: '• KWN-2-AB12_CD *paid*' }] })
  })
})

describe('buildOpsAlertPayload — slack', () => {
  it('keeps the original { text } body, with links and footer appended', () => {
    const payload = buildOpsAlertPayload(alert, 'slack', NOW)
    expect(Object.keys(payload)).toEqual(['text'])
    expect(payload.text).toBe(
      [
        '🚨 Verco notification health alert',
        '1 channel(s) failing over the last 3h:',
        '',
        '• SMS — 4 failed sends',
        'Check the Twilio dashboard.',
        '',
        `Notification log: ${ADMIN_ORIGIN}/admin/notifications`,
        '',
        'Sent by notification-health-check · 20/10/2026 15:15 AWST',
      ].join('\n'),
    )
  })
})

describe('PII backstop', () => {
  it('redacts emails and phone numbers but keeps ISO timestamps and booking refs', () => {
    expect(redactPii("Invalid 'To' Phone Number: +61412345678")).toBe("Invalid 'To' Phone Number: [phone]")
    expect(redactPii('call 0412 345 678 or 0895551234')).toBe('call [phone] or [phone]')
    expect(redactPii('bounce for resident@example.com')).toBe('bounce for [email]')
    expect(redactPii('last success: 2026-05-18T06:54:39.959Z')).toBe('last success: 2026-05-18T06:54:39.959Z')
    expect(redactPii('• MOS-JOZCOM, KWN-2-I2NA9E, MOS-12984')).toBe('• MOS-JOZCOM, KWN-2-I2NA9E, MOS-12984')
  })

  it('catches the AU and international shapes numbers arrive in', () => {
    expect(redactPii('to 61412345678')).toBe('to [phone]')
    expect(redactPii('to +61 412 345 678')).toBe('to [phone]')
    expect(redactPii('office 08 9555-1234')).toBe('office [phone]')
    expect(redactPii('office (08) 9555 1234')).toBe('office [phone]')
    expect(redactPii('mobile 412 345 678 (no 0)')).toBe('mobile [phone] (no 0)')
    expect(redactPii('UK +44 7700 900123')).toBe('UK [phone]')
  })

  // A blanket 8+-digit rule turned these into "[phone]", hiding the identifier
  // ops need to trace a provider failure.
  it('leaves long numeric IDs and error codes alone', () => {
    expect(redactPii('Twilio error 30008 for message 2026102012345')).toBe('Twilio error 30008 for message 2026102012345')
    expect(redactPii('legacy ref 39190123 failed')).toBe('legacy ref 39190123 failed')
    expect(redactPii('SendGrid batch 1234567890123456')).toBe('SendGrid batch 1234567890123456')
  })

  it('scrubs every line of both formats and caps runaway lines', () => {
    const leaky: OpsAlert = {
      source: 'notification-health-check',
      title: 'alert for resident@example.com',
      lines: ['last error: To +61412345678 unreachable', 'x'.repeat(MAX_LINE_LENGTH + 50)],
    }
    for (const format of ['teams', 'slack'] as const) {
      const json = JSON.stringify(buildOpsAlertPayload(leaky, format, NOW))
      expect(json).not.toContain('resident@example.com')
      expect(json).not.toContain('61412345678')
      expect(json).not.toContain('x'.repeat(MAX_LINE_LENGTH))
    }
  })

  it('strips URLs (the signed webhook URL) from error text', () => {
    expect(redactUrls(`error sending request for url (${WEBHOOK_URL}): connection refused`)).toBe(
      'error sending request for url ([webhook url]): connection refused',
    )
  })
})

describe('buildTestAlert', () => {
  it('is labelled as a test in both formats', () => {
    const test = buildTestAlert('notification-health-check')
    expect(opsAlertText(test, NOW).startsWith('TEST — ')).toBe(true)
    const card = buildAdaptiveCard(test, NOW).body as Array<Record<string, unknown>>
    const title = (card[0]!.inlines as Array<{ text: string; color: string }>)[0]!
    expect(title.color).toBe('Accent')
    expect(title.text).toMatch(/^TEST — .*no action needed/)
  })
})

describe('isTestAlertRequest', () => {
  it('only matches an explicit test_alert: true', () => {
    expect(isTestAlertRequest({ test_alert: true })).toBe(true)
    expect(isTestAlertRequest({})).toBe(false) // pg_cron's body
    expect(isTestAlertRequest({ test_alert: 'true' })).toBe(false)
    expect(isTestAlertRequest(null)).toBe(false)
  })
})

describe('formatAwst', () => {
  it('formats Perth time as DD/MM/YYYY HH:mm', () => {
    expect(formatAwst(new Date('2026-10-20T16:05:00.000Z'))).toBe('21/10/2026 00:05 AWST')
  })
})

describe('sendOpsAlert — delivered', () => {
  it('POSTs the teams payload by default, with no Authorization header', async () => {
    const fetchImpl = okFetch(202)
    const { promise, captureWarning } = send({}, fetchImpl)
    const result = await promise

    expect(result).toEqual({ delivered: true, format: 'teams', status: 202, responseBody: '' })
    expect(captureWarning).not.toHaveBeenCalled()
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(WEBHOOK_URL)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(String(init.body))).toEqual(buildOpsAlertPayload(alert, 'teams', NOW))
  })

  it('POSTs { text } when the format is slack', async () => {
    const fetchImpl = okFetch(200, 'ok')
    const result = await send({ format: 'slack' }, fetchImpl).promise
    expect(result).toMatchObject({ delivered: true, format: 'slack', status: 200, responseBody: 'ok' })
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit
    expect(JSON.parse(String(init.body))).toEqual({ text: opsAlertText(alert, NOW) })
  })
})

describe('sendOpsAlert — never silent', () => {
  it('raises a Sentry warning naming the secret when the URL is not set', async () => {
    const fetchImpl = okFetch()
    const { promise, captureWarning } = send({ webhookUrl: undefined }, fetchImpl)
    const result = await promise

    expect(result).toMatchObject({ delivered: false, reason: 'not_configured' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(captureWarning).toHaveBeenCalledWith(
      'notification-health-check: ops alert not sent — OPS_ALERT_WEBHOOK_URL is not set',
      expect.objectContaining({ reason: 'not_configured', source: 'notification-health-check' }),
    )
  })

  it('treats a blank URL as not set', async () => {
    const result = await send({ webhookUrl: '   ' }).promise
    expect(result).toMatchObject({ delivered: false, reason: 'not_configured' })
  })

  it('refuses an unknown format instead of posting the wrong shape', async () => {
    const fetchImpl = okFetch()
    const { promise, captureWarning } = send({ format: 'msteams' }, fetchImpl)
    const result = await promise

    expect(result).toMatchObject({ delivered: false, reason: 'invalid_format' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(captureWarning.mock.calls[0]![0]).toContain('OPS_ALERT_WEBHOOK_FORMAT')
  })

  it('reports a non-2xx answer with its status and body', async () => {
    const { promise, captureWarning } = send({}, okFetch(400, '{"error":{"code":"TriggerInputSchemaMismatch"}}'))
    const result = await promise

    expect(result).toEqual({
      delivered: false,
      reason: 'webhook_failed',
      error: 'webhook returned HTTP 400',
      format: 'teams',
      status: 400,
      responseBody: '{"error":{"code":"TriggerInputSchemaMismatch"}}',
    })
    expect(captureWarning).toHaveBeenCalledWith(
      'notification-health-check: ops alert not sent — webhook returned HTTP 400',
      expect.objectContaining({ reason: 'webhook_failed', status: 400, format: 'teams' }),
    )
  })

  it('reports a thrown POST without leaking the signed URL anywhere', async () => {
    const throwing = vi.fn(async () => {
      throw new TypeError(`error sending request for url (${WEBHOOK_URL}): dns error`)
    }) as unknown as typeof fetch
    const { promise, captureWarning } = send({}, throwing)
    const result = await promise

    expect(result).toMatchObject({ delivered: false, reason: 'webhook_failed', status: null })
    const everything = JSON.stringify([result, captureWarning.mock.calls])
    expect(everything).not.toContain('FIXTURE-SIGNATURE')
    expect(everything).not.toContain('powerplatform.com')
    expect(everything).toContain('[webhook url]')
  })

  it('labels a failed test alert as a test in the warning', async () => {
    const { promise, captureWarning } = send({ webhookUrl: undefined }, okFetch(), buildTestAlert('notification-health-check'))
    await promise
    expect(captureWarning).toHaveBeenCalledWith(
      'notification-health-check: test alert not sent — OPS_ALERT_WEBHOOK_URL is not set',
      expect.objectContaining({ test: true }),
    )
  })
})
