/**
 * Resolves the base URL for the "Log In" button in the create-user welcome
 * email. Pure — no env or DB access — so it is unit-tested via the
 * src/lib/notifications mirror (scripts/sync-mirrors.sh).
 *
 * Field-tier roles (ranger, field) work on the dedicated field host
 * (lib/proxy/hostnames.ts FIELD_HOSTNAME_PROD); the ranger guide tells them
 * to open field.verco.au, so the welcome link must match. Office roles keep
 * the tenant-host resolution that mirrors the proxy: custom_domain →
 * slug.verco.au → SITE_URL for contractor staff with no canonical tenant.
 */

const FIELD_LOGIN_BASE_URL = 'https://field.verco.au'
const FIELD_TIER_ROLES: readonly string[] = ['ranger', 'field']

export interface WelcomeLoginUrlInput {
  role: string
  clientId: string | null | undefined
  tenantCustomDomain: string | null | undefined
  tenantSlug: string | null | undefined
  /** SITE_URL env (or the verco.au fallback) — used only for tenant-less office roles. */
  siteUrl: string
}

export function resolveWelcomeLoginBaseUrl(input: WelcomeLoginUrlInput): string {
  if (FIELD_TIER_ROLES.includes(input.role)) {
    return FIELD_LOGIN_BASE_URL
  }
  if (input.clientId && input.tenantCustomDomain) {
    return `https://${input.tenantCustomDomain}`
  }
  if (input.clientId && input.tenantSlug) {
    return `https://${input.tenantSlug}.verco.au`
  }
  return input.siteUrl
}
