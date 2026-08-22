import { describe, expect, it } from 'vitest'
import { decideCronAuth } from '@/lib/auth/cron-request'

const ANON = 'eyJ.anon.sig'
const base = { envSecret: 's3cret', bearer: ANON, bearerIsServiceRole: false, anonKey: ANON }

describe('decideCronAuth (#517)', () => {
  it('accepts the matching X-Cron-Secret', () => {
    expect(decideCronAuth({ ...base, headerSecret: 's3cret' })).toEqual({ ok: true, via: 'cron-secret' })
  })

  it('accepts a proven service-role bearer regardless of the header (CLI path)', () => {
    expect(decideCronAuth({ ...base, headerSecret: null, bearerIsServiceRole: true })).toEqual({ ok: true, via: 'service-role' })
  })

  it('rejects the bare anon routing key with no header — and flags it as our cron (alert)', () => {
    expect(decideCronAuth({ ...base, headerSecret: null })).toEqual({
      ok: false, reason: 'not-service-role', looksLikeOurCron: true,
    })
  })

  it('rejects a wrong secret (bad-secret); publishable-key bearer also counts as our cron', () => {
    expect(decideCronAuth({ ...base, bearer: 'sb_publishable_x', headerSecret: 'nope' })).toEqual({
      ok: false, reason: 'bad-secret', looksLikeOurCron: true,
    })
  })

  it('fails CLOSED when CRON_SECRET is unset, even with a header present', () => {
    expect(decideCronAuth({ ...base, envSecret: undefined, headerSecret: 's3cret' })).toEqual({
      ok: false, reason: 'no-secret-configured', looksLikeOurCron: true,
    })
  })

  it('a stranger with no bearer is rejected and NOT flagged as our cron (no alert noise)', () => {
    expect(decideCronAuth({ ...base, bearer: '', headerSecret: null })).toEqual({
      ok: false, reason: 'not-service-role', looksLikeOurCron: false,
    })
  })

  it('empty header never matches an empty secret', () => {
    expect(decideCronAuth({ ...base, envSecret: '', headerSecret: '' }).ok).toBe(false)
  })
})
