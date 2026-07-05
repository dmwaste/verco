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

export async function resolveAuthHostContext(): Promise<{
  brand: AuthBrandCopy
  postLoginPath: string
}> {
  const headerStore = await headers()
  const host = headerStore.get('host') ?? ''

  if (isAdminHostname(host)) {
    return {
      brand: { serviceName: 'Verco Admin', contextLabel: 'Operator sign-in', variant: 'verco', logoUrl: null },
      postLoginPath: '/admin',
    }
  }
  if (isFieldHostname(host)) {
    return {
      brand: { serviceName: 'Verco Crew', contextLabel: 'Field sign-in', variant: 'verco', logoUrl: null },
      postLoginPath: '/field',
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

  return { brand, postLoginPath: '/dashboard' }
}
