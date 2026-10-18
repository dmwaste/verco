/**
 * Hostname-driven copy + post-login routing for the auth flow.
 *
 * The auth pages (entry, verify) and the callback share the same per-host
 * logic: which brand strings to show, and where to land the user after
 * verification succeeds.
 *
 * Server-side only — relies on `headers()` from `next/headers`. Client
 * components receive the resolved values as props.
 */

import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { isAdminHostname, isFieldHostname } from '@/lib/proxy/hostnames'
import { safeNextPath } from '@/lib/auth/next-path'

export interface AuthBrandCopy {
  serviceName: string
  contextLabel: string
  /** 'verco' on the operator hosts (admin/field) → render the Verco logo lockup.
   *  'tenant' on resident subdomains → render the tenant's own logo/initial on
   *  its primary colour (never the Verco mark — white-label). */
  variant: 'verco' | 'tenant'
  /** Tenant light logo (tenant variant only); null → initial fallback. */
  logoUrl: string | null
}

export function postLoginPathForHost(host: string): string {
  if (isAdminHostname(host)) return '/admin'
  if (isFieldHostname(host)) return '/field'
  return '/dashboard'
}

/**
 * `rawNext` is the `?next=` return path (VER-316). It replaces the host's
 * default landing only when it is a same-host path; `next` is the validated
 * value (or null) for the pages to carry forward.
 */
export async function resolveAuthHostContext(rawNext?: unknown): Promise<{
  brand: AuthBrandCopy
  postLoginPath: string
  next: string | null
}> {
  const headerStore = await headers()
  const host = headerStore.get('host') ?? ''
  const next = safeNextPath(rawNext)

  if (isAdminHostname(host)) {
    return {
      brand: { serviceName: 'Verco Admin', contextLabel: 'Operator sign-in', variant: 'verco', logoUrl: null },
      postLoginPath: next ?? '/admin',
      next,
    }
  }
  if (isFieldHostname(host)) {
    return {
      brand: { serviceName: 'Verco Crew', contextLabel: 'Field sign-in', variant: 'verco', logoUrl: null },
      postLoginPath: next ?? '/field',
      next,
    }
  }

  // Client subdomain: pull display name + logo from the resolved tenant.
  const clientId = headerStore.get('x-client-id')
  let brand: AuthBrandCopy = {
    serviceName: 'Verge Collection',
    contextLabel: '',
    variant: 'tenant',
    logoUrl: null,
  }

  if (clientId) {
    const supabase = await createClient()
    const { data: client } = await supabase
      .from('client')
      .select('name, service_name, logo_light_url')
      .eq('id', clientId)
      .single()
    if (client) {
      brand = {
        serviceName: client.service_name ?? 'Verge Collection',
        contextLabel: client.name,
        variant: 'tenant',
        logoUrl: client.logo_light_url,
      }
    }
  }

  return { brand, postLoginPath: next ?? '/dashboard', next }
}
