/**
 * Hostname helpers for the proxy's tenant-resolution branch.
 *
 * Verco's proxy resolves a tenant by reading the request `Host` header and
 * looking up a `client` row by slug or custom_domain. Two route surfaces
 * are NOT per-client and don't belong on a client subdomain:
 *
 * - `admin.verco.au` — operator surface, contractor-scoped. A contractor-admin
 *   may span multiple clients; pinning them to one client subdomain forces
 *   N tabs and fights the "view all my clients" workflow.
 * - `field.verco.au` — crew PWA, contractor-scoped. A crew dispatched by a
 *   contractor often handles stops at multiple clients in one shift; the
 *   per-client subdomain can't represent that.
 *
 * These helpers check the hostname prefix so the same code works in:
 * - production: `admin.verco.au`, `field.verco.au`
 * - dev:        `admin.localhost:3000`, `field.localhost:3000`
 *
 * Hostname rewriting (`toAdminHostname` / `toFieldHostname`) is used by
 * the proxy when 301-redirecting old `{client}.verco.au/admin/*` URLs to
 * the new dedicated host while preserving the protocol + path + query.
 */

export const ADMIN_HOSTNAME_PROD = 'admin.verco.au'
export const FIELD_HOSTNAME_PROD = 'field.verco.au'

/**
 * Root-host (marketing landing) contract.
 *
 * `verco.au` and `www.verco.au` are the unscoped root surface — no tenant.
 * `root.localhost` is the dev/test alias (RFC 6761 resolves *.localhost to
 * loopback; precedent: admin.localhost). It is intentionally NOT gated by
 * NODE_ENV: a production request forging `Host: root.localhost` only earns
 * the public marketing page, and the e2e suite depends on the alias against
 * a dev server.
 */
export const ROOT_HOSTNAME_PROD = 'verco.au'
export const WWW_HOSTNAME_PROD = 'www.verco.au'
const ROOT_HOSTNAME_DEV = 'root.localhost'

/**
 * Request headers owned by the proxy. Set by the proxy on forward/rewrite,
 * read by server components — and therefore stripped from INBOUND requests
 * on non-root branches so a client can never smuggle them in.
 * (`x-verco-root` gates the landing page render; `x-verco-bref-miss` shows
 * the stale-SMS-link recovery banner; the tenant trio scopes everything.)
 */
export const X_VERCO_ROOT = 'x-verco-root'
export const X_VERCO_BREF_MISS = 'x-verco-bref-miss'
export const PROXY_OWNED_REQUEST_HEADERS = [
  X_VERCO_ROOT,
  X_VERCO_BREF_MISS,
  'x-client-id',
  'x-client-slug',
  'x-contractor-id',
] as const

function hostnameOnly(host: string): string {
  return (host.toLowerCase().split(':')[0] ?? '').trim()
}

/** verco.au, www.verco.au, or the dev alias — port-tolerant, case-insensitive. */
export function isRootHostname(host: string): boolean {
  const h = hostnameOnly(host)
  return (
    h === ROOT_HOSTNAME_PROD || h === WWW_HOSTNAME_PROD || h === ROOT_HOSTNAME_DEV
  )
}

/** The www variant specifically — it 308s to the apex. */
export function isWwwHostname(host: string): boolean {
  return hostnameOnly(host) === WWW_HOSTNAME_PROD
}

const ADMIN_PREFIX = 'admin.'
const FIELD_PREFIX = 'field.'

export function isAdminHostname(host: string): boolean {
  return host.toLowerCase().startsWith(ADMIN_PREFIX)
}

export function isFieldHostname(host: string): boolean {
  return host.toLowerCase().startsWith(FIELD_PREFIX)
}

/**
 * Rewrite a hostname's first DNS segment so the same base-domain (and port)
 * is preserved but the discriminator changes. Used to map a client-subdomain
 * request to its admin/field counterpart for the 301 redirect.
 *
 * Examples:
 * - `vvtest.verco.au`         → `admin.verco.au`
 * - `kwntest.localhost:3000`  → `admin.localhost:3000`
 * - `localhost:3000`          → `admin.localhost:3000` (bare host gets prefix)
 */
function rewriteFirstSegment(host: string, replacement: string): string {
  if (!host.includes('.')) {
    return `${replacement}.${host}`
  }
  const parts = host.split('.')
  parts[0] = replacement
  return parts.join('.')
}

export function toAdminHostname(host: string): string {
  return rewriteFirstSegment(host, 'admin')
}

export function toFieldHostname(host: string): string {
  return rewriteFirstSegment(host, 'field')
}

function isLocalhostHost(host: string): boolean {
  const hostname = host.toLowerCase().split(':')[0] ?? ''
  return hostname === 'localhost' || hostname.endsWith('.localhost')
}

/**
 * Absolute origin of the operator surface, for an "Admin" link rendered on a
 * resident-facing (tenant) page. The admin surface is ALWAYS `admin.verco.au`
 * in production — never per-tenant, even for a council on a custom
 * resident-facing domain. In local dev it mirrors the current localhost port
 * (`admin.localhost:3000`) so the cross-host link still resolves.
 *
 * Unlike `toAdminHostname` (a first-segment rewrite used by the proxy's
 * redirect), the prod branch here is the fixed constant — so it is correct
 * regardless of which tenant host rendered the page:
 *
 * - `kwntest.verco.au`         → `https://admin.verco.au`
 * - `bins.council.wa.gov.au`   → `https://admin.verco.au`  (custom domain: still us)
 * - `kwntest.localhost:3000`   → `http://admin.localhost:3000`
 * - `localhost:3000`           → `http://admin.localhost:3000`
 */
export function adminOrigin(currentHost: string): string {
  if (isLocalhostHost(currentHost)) {
    return `http://${toAdminHostname(currentHost)}`
  }
  return `https://${ADMIN_HOSTNAME_PROD}`
}
