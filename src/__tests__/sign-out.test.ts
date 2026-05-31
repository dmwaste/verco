import { describe, it, expect } from 'vitest'
import { signOutRedirectPath } from '@/lib/auth/sign-out'

describe('signOutRedirectPath', () => {
  it("resident ('home') lands on the public landing", () => {
    expect(signOutRedirectPath('home')).toBe('/')
  })

  it("staff/field ('login') lands on /auth", () => {
    expect(signOutRedirectPath('login')).toBe('/auth')
  })

  // Open-redirect safety: the destination comes from a user-tamperable hidden
  // field, so anything that is not exactly 'home' must fall back to /auth and
  // never echo the input as a URL.
  it('tampered / unknown / external value falls back to /auth (no open redirect)', () => {
    expect(signOutRedirectPath('https://evil.example.com')).toBe('/auth')
    expect(signOutRedirectPath('//evil.example.com')).toBe('/auth')
    expect(signOutRedirectPath('/admin')).toBe('/auth')
    expect(signOutRedirectPath('')).toBe('/auth')
    expect(signOutRedirectPath(null)).toBe('/auth')
    expect(signOutRedirectPath(undefined)).toBe('/auth')
    expect(signOutRedirectPath(42)).toBe('/auth')
  })
})
