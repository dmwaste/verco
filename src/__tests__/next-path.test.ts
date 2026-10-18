import { describe, it, expect } from 'vitest'
import { loginPath, safeNextPath } from '@/lib/auth/next-path'

describe('loginPath', () => {
  it('carries the return path, encoded, so its own query string survives', () => {
    expect(loginPath('/admin/lookup?phone=+61412345678')).toBe(
      '/auth?next=%2Fadmin%2Flookup%3Fphone%3D%2B61412345678',
    )
  })

  it('is plain /auth when there is nowhere to return to', () => {
    expect(loginPath(null)).toBe('/auth')
  })

  it('round-trips through the query string and the guard intact', () => {
    const next = new URL(loginPath('/admin/lookup?phone=+61412345678'), 'https://admin.verco.au')
      .searchParams.get('next')
    expect(safeNextPath(next)).toBe('/admin/lookup?phone=+61412345678')
  })
})

/**
 * The post-login return path (VER-316) arrives in a user-controllable query
 * param, so it must only ever resolve to a path on the current host.
 */
describe('safeNextPath', () => {
  it('keeps a same-host path with its query string', () => {
    expect(safeNextPath('/admin/lookup?phone=+61412345678')).toBe(
      '/admin/lookup?phone=+61412345678',
    )
    expect(safeNextPath('/admin')).toBe('/admin')
  })

  it.each([
    ['https://evil.example', 'absolute URL'],
    ['//evil.example', 'protocol-relative'],
    ['/\\evil.example', 'backslash (browsers read it as /)'],
    ['\\\\evil.example', 'double backslash'],
    ['/\t/evil.example', 'tab the URL parser strips'],
    ['/.//evil.example', 'dot segment normalised away to //'],
    ['/..//evil.example', 'dot-dot segment normalised away to //'],
    ['/a/..//evil.example', 'dot-dot after a segment'],
    ['/%2e//evil.example', 'encoded dot segment'],
    ['javascript:alert(1)', 'script URL'],
    ['admin/lookup', 'relative without a leading /'],
    ['', 'empty'],
  ])('rejects %j (%s)', (raw) => {
    expect(safeNextPath(raw)).toBeNull()
  })

  it('rejects non-string input (missing or repeated param)', () => {
    expect(safeNextPath(undefined)).toBeNull()
    expect(safeNextPath(null)).toBeNull()
    expect(safeNextPath(['/admin', '/field'])).toBeNull()
  })
})
