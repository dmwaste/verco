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

const files = walk(FUNCTIONS_DIR).map((f) => ({
  path: relative(ROOT, f),
  text: readFileSync(f, 'utf8'),
}))

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
})
