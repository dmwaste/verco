import { describe, it, expect } from 'vitest'
import {
  isAdminHostname,
  isFieldHostname,
  toAdminHostname,
  toFieldHostname,
  adminOrigin,
  ADMIN_HOSTNAME_PROD,
  FIELD_HOSTNAME_PROD,
} from '@/lib/proxy/hostnames'

describe('isAdminHostname', () => {
  it('returns true for prod admin host', () => {
    expect(isAdminHostname('admin.verco.au')).toBe(true)
  })

  it('returns true for dev admin host', () => {
    expect(isAdminHostname('admin.localhost:3000')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isAdminHostname('Admin.Verco.AU')).toBe(true)
  })

  it('returns false for client subdomain', () => {
    expect(isAdminHostname('vvtest.verco.au')).toBe(false)
  })

  it('returns false for bare verco.au', () => {
    expect(isAdminHostname('verco.au')).toBe(false)
  })

  it('returns false for similar-looking but not-prefix hosts', () => {
    expect(isAdminHostname('myadmin.verco.au')).toBe(false)
    expect(isAdminHostname('adminx.verco.au')).toBe(false)
  })
})

describe('isFieldHostname', () => {
  it('returns true for prod field host', () => {
    expect(isFieldHostname('field.verco.au')).toBe(true)
  })

  it('returns true for dev field host', () => {
    expect(isFieldHostname('field.localhost:3000')).toBe(true)
  })

  it('returns false for client subdomain', () => {
    expect(isFieldHostname('kwntest.verco.au')).toBe(false)
  })

  it('returns false for admin host', () => {
    expect(isFieldHostname('admin.verco.au')).toBe(false)
  })
})

describe('toAdminHostname', () => {
  it('rewrites client prod subdomain', () => {
    expect(toAdminHostname('vvtest.verco.au')).toBe('admin.verco.au')
    expect(toAdminHostname('kwntest.verco.au')).toBe('admin.verco.au')
  })

  it('rewrites client dev subdomain', () => {
    expect(toAdminHostname('kwntest.localhost:3000')).toBe('admin.localhost:3000')
  })

  it('prepends admin prefix to bare hostnames', () => {
    expect(toAdminHostname('localhost:3000')).toBe('admin.localhost:3000')
    expect(toAdminHostname('localhost')).toBe('admin.localhost')
  })

  it('is idempotent for already-admin hosts', () => {
    expect(toAdminHostname('admin.verco.au')).toBe('admin.verco.au')
  })
})

describe('toFieldHostname', () => {
  it('rewrites client prod subdomain to field', () => {
    expect(toFieldHostname('vvtest.verco.au')).toBe('field.verco.au')
  })

  it('rewrites client dev subdomain to field', () => {
    expect(toFieldHostname('kwntest.localhost:3000')).toBe('field.localhost:3000')
  })

  it('prepends field prefix to bare hostnames', () => {
    expect(toFieldHostname('localhost:3000')).toBe('field.localhost:3000')
  })
})

describe('adminOrigin', () => {
  it('returns the fixed prod constant for any *.verco.au tenant', () => {
    expect(adminOrigin('kwntest.verco.au')).toBe('https://admin.verco.au')
    expect(adminOrigin('vvtest.verco.au')).toBe('https://admin.verco.au')
  })

  it('returns the prod constant for the root host', () => {
    expect(adminOrigin('verco.au')).toBe('https://admin.verco.au')
  })

  it('returns the prod constant for a custom resident-facing domain (still us)', () => {
    expect(adminOrigin('bins.council.wa.gov.au')).toBe('https://admin.verco.au')
  })

  it('mirrors the localhost port for a dev tenant subdomain', () => {
    expect(adminOrigin('kwntest.localhost:3000')).toBe('http://admin.localhost:3000')
  })

  it('handles bare localhost', () => {
    expect(adminOrigin('localhost:3000')).toBe('http://admin.localhost:3000')
    expect(adminOrigin('localhost')).toBe('http://admin.localhost')
  })

  it('is already-admin-host safe (idempotent target)', () => {
    expect(adminOrigin('admin.verco.au')).toBe('https://admin.verco.au')
    expect(adminOrigin('admin.localhost:3000')).toBe('http://admin.localhost:3000')
  })

  it('falls back to the prod constant for an empty host', () => {
    expect(adminOrigin('')).toBe('https://admin.verco.au')
  })
})

describe('host constants', () => {
  it('match the documented production values', () => {
    expect(ADMIN_HOSTNAME_PROD).toBe('admin.verco.au')
    expect(FIELD_HOSTNAME_PROD).toBe('field.verco.au')
  })
})
