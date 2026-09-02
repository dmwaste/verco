/**
 * Welcome-email login link resolution (create-user EF).
 *
 * Field-tier roles (ranger, field) live on the dedicated field host — the
 * ranger guide tells them to open field.verco.au. Sending them to the
 * tenant's resident host contradicts their training and, once the
 * admin-host redirect is enforced, costs them a second OTP login.
 * Everyone else keeps the historical tenant-host resolution.
 */
import { describe, it, expect } from 'vitest'
import { resolveWelcomeLoginBaseUrl } from '@/lib/notifications/welcome-login-url'

const SITE_URL = 'https://verco.au'

describe('resolveWelcomeLoginBaseUrl', () => {
  it('sends a ranger to the field host even when the tenant has a custom domain', () => {
    expect(
      resolveWelcomeLoginBaseUrl({
        role: 'ranger',
        clientId: 'c1',
        tenantCustomDomain: 'kwn.verco.au',
        tenantSlug: 'kwn',
        siteUrl: SITE_URL,
      }),
    ).toBe('https://field.verco.au')
  })

  it('sends a ranger to the field host when the tenant only has a slug', () => {
    expect(
      resolveWelcomeLoginBaseUrl({
        role: 'ranger',
        clientId: 'c1',
        tenantCustomDomain: null,
        tenantSlug: 'vergevalet',
        siteUrl: SITE_URL,
      }),
    ).toBe('https://field.verco.au')
  })

  it('sends contractor field crew to the field host (no tenant at all)', () => {
    expect(
      resolveWelcomeLoginBaseUrl({
        role: 'field',
        clientId: null,
        tenantCustomDomain: null,
        tenantSlug: null,
        siteUrl: SITE_URL,
      }),
    ).toBe('https://field.verco.au')
  })

  it('keeps client-tier office roles on the tenant custom domain', () => {
    expect(
      resolveWelcomeLoginBaseUrl({
        role: 'client-admin',
        clientId: 'c1',
        tenantCustomDomain: 'kwn.verco.au',
        tenantSlug: 'kwn',
        siteUrl: SITE_URL,
      }),
    ).toBe('https://kwn.verco.au')
  })

  it('falls back to the tenant slug subdomain when no custom domain is set', () => {
    expect(
      resolveWelcomeLoginBaseUrl({
        role: 'client-staff',
        clientId: 'c1',
        tenantCustomDomain: null,
        tenantSlug: 'kwn',
        siteUrl: SITE_URL,
      }),
    ).toBe('https://kwn.verco.au')
  })

  it('keeps contractor office roles on SITE_URL', () => {
    expect(
      resolveWelcomeLoginBaseUrl({
        role: 'contractor-admin',
        clientId: null,
        tenantCustomDomain: null,
        tenantSlug: null,
        siteUrl: SITE_URL,
      }),
    ).toBe(SITE_URL)
  })

  it('ignores tenant hostname fields for a client-tier role with no client id', () => {
    expect(
      resolveWelcomeLoginBaseUrl({
        role: 'client-admin',
        clientId: null,
        tenantCustomDomain: 'kwn.verco.au',
        tenantSlug: 'kwn',
        siteUrl: SITE_URL,
      }),
    ).toBe(SITE_URL)
  })
})
