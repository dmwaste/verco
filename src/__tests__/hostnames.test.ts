import { describe, it, expect } from 'vitest'
import {
  isRootHostname,
  isWwwHostname,
  PROXY_OWNED_REQUEST_HEADERS,
  X_VERCO_ROOT,
  X_VERCO_BREF_MISS,
} from '@/lib/proxy/hostnames'

describe('isRootHostname', () => {
  it('matches the apex host', () => {
    expect(isRootHostname('verco.au')).toBe(true)
  })

  it('matches the www variant', () => {
    expect(isRootHostname('www.verco.au')).toBe(true)
  })

  it('matches the dev alias with a port', () => {
    expect(isRootHostname('root.localhost:3000')).toBe(true)
  })

  it('is case-insensitive and port-tolerant', () => {
    expect(isRootHostname('WWW.VERCO.AU:443')).toBe(true)
    expect(isRootHostname('Verco.AU')).toBe(true)
    expect(isRootHostname('ROOT.LOCALHOST:3000')).toBe(true)
  })

  it('rejects tenant, admin, field, and bare-localhost hosts', () => {
    expect(isRootHostname('kwntest.verco.au')).toBe(false)
    expect(isRootHostname('vvtest.verco.au')).toBe(false)
    expect(isRootHostname('admin.verco.au')).toBe(false)
    expect(isRootHostname('field.verco.au')).toBe(false)
    expect(isRootHostname('localhost:3000')).toBe(false)
    expect(isRootHostname('admin.localhost:3000')).toBe(false)
  })

  it('rejects lookalike hosts', () => {
    expect(isRootHostname('verco.au.evil.com')).toBe(false)
    expect(isRootHostname('notverco.au')).toBe(false)
  })
})

describe('isWwwHostname', () => {
  it('matches only the www production host', () => {
    expect(isWwwHostname('www.verco.au')).toBe(true)
    expect(isWwwHostname('WWW.verco.au:443')).toBe(true)
    expect(isWwwHostname('verco.au')).toBe(false)
    expect(isWwwHostname('root.localhost:3000')).toBe(false)
  })
})

describe('proxy-owned request headers', () => {
  it('covers the landing gate, banner marker, and tenant trio', () => {
    expect(PROXY_OWNED_REQUEST_HEADERS).toContain(X_VERCO_ROOT)
    expect(PROXY_OWNED_REQUEST_HEADERS).toContain(X_VERCO_BREF_MISS)
    expect(PROXY_OWNED_REQUEST_HEADERS).toContain('x-client-id')
    expect(PROXY_OWNED_REQUEST_HEADERS).toContain('x-client-slug')
    expect(PROXY_OWNED_REQUEST_HEADERS).toContain('x-contractor-id')
  })
})
