/**
 * Guard: every Edge Function that fires booking_created goes through the ONE
 * shared, retrying helper (`_shared/invoke-send-notification.ts`) and awaits it.
 *
 * Before 18/10/2026 create-booking and checkout-reconcile each carried a
 * copy-pasted one-shot `invokeSendNotification` called with a bare `void`: a
 * gateway 502 on the EF→EF hop dropped the resident's confirmation with no
 * notification_log row and no Sentry event (MOS-JOZCOM, KWN-2-I2NA9E). A bare
 * `void` also lets the edge runtime freeze the fetch mid-flight once the
 * handler returns.
 *
 * #671 extends the guard to `src/`: the admin MUD booking path still called the
 * one-shot `invokeSendNotification` with a bare `void`, so a gateway blip lost
 * the strata contact's confirmation the same way. Server code that fires
 * booking_created now awaits `invokeBookingCreated` (retry + failed row).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const FUNCTIONS_DIR = join(ROOT, 'supabase', 'functions')
const SHARED_HELPER = 'supabase/functions/_shared/invoke-send-notification.ts'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : []
  })
}

const read = (f: string) => ({ path: relative(ROOT, f), text: readFileSync(f, 'utf8') })

const files = walk(FUNCTIONS_DIR).map(read)

// Server-side app code: everything under src/ except tests. (Client
// components fire their own EF calls from the browser — no runtime freeze —
// so only send-notification invokers are matched, not every `void invoke…`.)
function walkSource(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : walkSource(full)
    return /\.tsx?$/.test(full) ? [full] : []
  })
}

const srcFiles = walkSource(join(ROOT, 'src')).map(read)

const MUD_ACTION = 'src/app/(admin)/admin/properties/[id]/book/actions.ts'


describe('booking_created invoke paths', () => {
  it('defines invokeSendNotification only in the shared helper', () => {
    const definers = files
      .filter((f) => /async function invokeSendNotification\b/.test(f.text))
      .map((f) => f.path)
    expect(definers).toEqual([SHARED_HELPER])
  })

  it('has no bare `void invokeSendNotification` left in any Edge Function', () => {
    const offenders = files.filter((f) => /void invokeSendNotification\b/.test(f.text)).map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('both the free path and the paid path import the shared helper', () => {
    const importers = files
      .filter((f) => f.path !== SHARED_HELPER && /from '(\.\.\/_shared|\.)\/invoke-send-notification\.ts'/.test(f.text))
      .map((f) => f.path)
      .sort()
    expect(importers).toEqual([
      'supabase/functions/_shared/checkout-reconcile.ts',
      'supabase/functions/create-booking/index.ts',
    ])
  })

  it('has no bare `void` notification invoke anywhere in src/', () => {
    // Includes the browser-side ticket reply hop: a dropped `void` promise
    // there loses the resident's reply email with only a console line, and
    // the staff member who just replied never hears (#671 follow-up).
    const offenders = srcFiles
      .filter((f) => /void\s+invoke(SendNotification|BookingCreated|NotifyTicketResponse)\b/.test(f.text))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('the admin MUD booking path awaits the retrying booking_created helper', () => {
    const text = srcFiles.find((f) => f.path === MUD_ACTION)?.text ?? ''
    expect(text).toMatch(/await invokeBookingCreated\(/)
    expect(text).not.toMatch(/type: 'booking_created'/)
  })

  it('src/ fires booking_created only through invokeBookingCreated', () => {
    const offenders = srcFiles
      .filter((f) => f.path !== 'src/lib/notifications/invoke.ts')
      .filter((f) => /invokeSendNotification\([^)]*type:\s*'booking_created'/.test(f.text))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })
})
