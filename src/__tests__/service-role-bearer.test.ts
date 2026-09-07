import { describe, expect, it } from 'vitest'
import { classifyServiceRoleBearer } from '@/lib/auth/service-role-auth'

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload: object) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`

describe('classifyServiceRoleBearer (#480)', () => {
  const envKey = jwt({ role: 'service_role', iss: 'supabase' })

  it('exact match with the injected key → match', () => {
    expect(classifyServiceRoleBearer(envKey, envKey)).toBe('match')
  })

  it('empty bearer never matches, even when the env key is unset', () => {
    expect(classifyServiceRoleBearer('', '')).toBe('no')
    expect(classifyServiceRoleBearer('', undefined)).toBe('no')
  })

  it('a DIFFERENT service_role JWT (legacy key after rotation) → claims, so the caller probes the gateway', () => {
    const legacy = jwt({ role: 'service_role', iss: 'supabase', iat: 1 })
    expect(classifyServiceRoleBearer(legacy, envKey)).toBe('claims')
  })

  it('new-format secret key (sb_secret_…) → claims', () => {
    expect(classifyServiceRoleBearer('sb_secret_abc123', envKey)).toBe('claims')
  })

  it('anon / authenticated JWTs and publishable keys → no (fall through to user-JWT path)', () => {
    expect(classifyServiceRoleBearer(jwt({ role: 'anon' }), envKey)).toBe('no')
    expect(classifyServiceRoleBearer(jwt({ role: 'authenticated', sub: 'u1' }), envKey)).toBe('no')
    expect(classifyServiceRoleBearer('sb_publishable_abc', envKey)).toBe('no')
  })

  it('garbage that is not a JWT → no', () => {
    expect(classifyServiceRoleBearer('not.a.jwt', envKey)).toBe('no')
    expect(classifyServiceRoleBearer('undefined', envKey)).toBe('no')
  })
})
