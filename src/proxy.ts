import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import type { Database } from '@/lib/supabase/types'
import {
  isAdminHostname,
  isFieldHostname,
  toAdminHostname,
  toFieldHostname,
} from '@/lib/proxy/hostnames'

type AppRole = Database['public']['Enums']['app_role']

const ADMIN_ROLES: AppRole[] = [
  'client-admin',
  'client-staff',
  'contractor-admin',
  'contractor-staff',
]

const FIELD_ROLES: AppRole[] = ['field', 'ranger']

// Paths legitimately served on admin.verco.au.
// - /admin: the operator surface (role-guarded)
// - /auth, /api: login + healthcheck (no role required)
// - /book, /survey: staff "act on behalf of resident" flows — switcher-driven
//   tenant resolution sets x-client-id from the verco_admin_client cookie so
//   the resident booking wizard runs against the currently-selected client
const ADMIN_ALLOWED_PREFIXES = ['/admin', '/auth', '/api', '/book', '/survey']
const FIELD_ALLOWED_PREFIXES = ['/field', '/auth', '/api']

// Switcher-driven tenant cookie. Kept in sync with
// CURRENT_ADMIN_CLIENT_COOKIE in src/lib/admin/current-client.ts.
const SWITCHER_COOKIE = 'verco_admin_client'

const DEBUG_PROXY =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROXY === '1'

// When true, the proxy 308-redirects `{client}.verco.au/admin/*` and `/field/*`
// to the dedicated `admin.verco.au` / `field.verco.au` hosts. Default false
// until DNS + Coolify aliases for the new hosts are live, otherwise the
// redirect breaks the existing admin surface. Server-only (not NEXT_PUBLIC).
const ADMIN_SUBDOMAIN_ENFORCED =
  process.env.ADMIN_SUBDOMAIN_ENFORCED === 'true' ||
  process.env.ADMIN_SUBDOMAIN_ENFORCED === '1'

function makeSupabaseClient(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  return {
    supabase,
    forwardCookies(target: NextResponse) {
      supabaseResponse.cookies.getAll().forEach((cookie) => {
        target.cookies.set(cookie)
      })
      return target
    },
  }
}

// The unscoped marketing-stub host. Verco's root domain doesn't map to a
// tenant — it serves a landing page that lets a council partner pick their
// tenant, and a /b/<ref> redirect endpoint used as the canonical URL in
// transactional SMS messages.
const ROOT_HOST = 'verco.au'

// Internal rewrite target for the root landing page. Single source of truth so
// the proxy can short-circuit when it sees the rewritten path (otherwise the
// matcher re-enters the proxy and infinite-loops).
const ROOT_LANDING_PATH = '/landing'

export async function proxy(request: NextRequest) {
  // Healthcheck bypass: Docker HEALTHCHECK hits /api/health from the container's
  // internal network, so there is no tenant-resolving hostname to match. Skip
  // the tenant lookup, auth refresh, and route guard so the probe stays cheap
  // and immune to tenant-config drift.
  if (request.nextUrl.pathname === '/api/health') {
    return NextResponse.next()
  }

  const hostname = request.headers.get('host') ?? ''
  const path = request.nextUrl.pathname
  if (DEBUG_PROXY) {
    console.log(
      `[proxy] hostname="${hostname}" path="${path}" NODE_ENV="${process.env.NODE_ENV}"`
    )
  }

  // -----------------------------------------------------------------------
  // Branch Z — root host (verco.au): /b/<ref> redirect + landing stub
  // -----------------------------------------------------------------------
  if (hostname === ROOT_HOST) {
    return handleRootHost(request, path)
  }

  const isAdminHost = isAdminHostname(hostname)
  const isFieldHost = isFieldHostname(hostname)

  // -----------------------------------------------------------------------
  // Branch A — admin / field hosts: skip client lookup, contractor-scoped
  // -----------------------------------------------------------------------
  if (isAdminHost || isFieldHost) {
    return handleContractorHost(request, {
      isAdmin: isAdminHost,
      path,
    })
  }

  // -----------------------------------------------------------------------
  // Branch B — client subdomain + /admin or /field path: gated 308 redirect
  // to the dedicated host. Disabled by default until DNS + Coolify aliases
  // for admin.verco.au / field.verco.au are confirmed live.
  // -----------------------------------------------------------------------
  if (ADMIN_SUBDOMAIN_ENFORCED) {
    if (path.startsWith('/admin')) {
      const url = request.nextUrl.clone()
      url.host = toAdminHostname(hostname)
      return NextResponse.redirect(url, 308)
    }
    if (path.startsWith('/field')) {
      const url = request.nextUrl.clone()
      url.host = toFieldHostname(hostname)
      return NextResponse.redirect(url, 308)
    }
  }

  // -----------------------------------------------------------------------
  // Branch C — client subdomain, public/resident routes: existing behaviour
  // -----------------------------------------------------------------------
  return handleClientHost(request)
}

async function handleRootHost(request: NextRequest, path: string) {
  // Short-circuit when the rewrite has already happened (otherwise the
  // matcher re-runs the proxy on the rewritten path and we loop forever).
  if (path === ROOT_LANDING_PATH) {
    return NextResponse.next()
  }

  // /b/<ref>: canonical SMS link target. Resolves via the SECURITY DEFINER
  // RPC `resolve_booking_redirect` because anon can't SELECT booking
  // directly (all 4 RLS policies require an authenticated role). The RPC
  // returns just custom_domain + is_active — no PII. For unknown refs we
  // fall through to the landing rather than 404 to give the recipient a
  // recovery path if a stale URL is followed.
  const bMatch = path.match(/^\/b\/([A-Za-z0-9-]+)$/)
  if (bMatch) {
    const ref = bMatch[1]!
    const { supabase } = makeSupabaseClient(request)
    const { data } = await supabase.rpc('resolve_booking_redirect', { p_ref: ref })
    const row = (data ?? [])[0] as
      | { custom_domain: string | null; is_active: boolean }
      | undefined

    if (row?.is_active && row.custom_domain) {
      return NextResponse.redirect(
        `https://${row.custom_domain}/booking/${ref}`,
        302,
      )
    }
    // Booking not found OR tenant inactive OR custom_domain unset — fall
    // through to the landing.
  }

  // All other paths: rewrite to the landing page. Header tells the page
  // route to render (otherwise it 404s, so direct hits to /landing on a
  // tenant subdomain don't leak the root surface).
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-verco-root', '1')
  const url = request.nextUrl.clone()
  url.pathname = ROOT_LANDING_PATH
  return NextResponse.rewrite(url, { request: { headers: requestHeaders } })
}

async function handleContractorHost(
  request: NextRequest,
  { isAdmin, path }: { isAdmin: boolean; path: string }
) {
  // Caller invariant: this fn is only invoked when isAdminHost || isFieldHost
  // is true, so `!isAdmin` implies field-host. Don't add a 3rd contractor
  // host type without revisiting the else-branches below.
  const canonicalPath = isAdmin ? '/admin' : '/field'
  const requiredRoles = isAdmin ? ADMIN_ROLES : FIELD_ROLES
  const allowedPrefixes = isAdmin
    ? ADMIN_ALLOWED_PREFIXES
    : FIELD_ALLOWED_PREFIXES

  // Path-of-this-host must start with one of the allowed prefixes —
  // anything else (e.g. /dashboard on admin.verco.au) is a wrong-host request
  // and redirects to the canonical surface. /auth and /api are allowed
  // because login + healthcheck need to work without a role.
  const isAllowedPath = allowedPrefixes.some((prefix) => path.startsWith(prefix))
  if (!isAllowedPath) {
    return NextResponse.redirect(new URL(canonicalPath, request.url))
  }

  const { supabase, forwardCookies } = makeSupabaseClient(request)
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // /auth and /api: no role required, just refresh session and pass through.
  if (path.startsWith('/auth') || path.startsWith('/api')) {
    return forwardCookies(NextResponse.next({ request }))
  }

  // Everything else under admin/field requires login + matching role.
  if (!user) {
    return NextResponse.redirect(new URL('/auth', request.url))
  }

  const { data: userRoles } = await supabase
    .from('user_roles')
    .select('role, contractor_id')
    .eq('user_id', user.id)
    .eq('is_active', true)

  const matchingRole = (userRoles ?? []).find((r) =>
    requiredRoles.includes(r.role)
  )

  if (!matchingRole) {
    return NextResponse.redirect(new URL('/auth', request.url))
  }

  const requestHeaders = new Headers(request.headers)
  if (matchingRole.contractor_id) {
    requestHeaders.set('x-contractor-id', matchingRole.contractor_id)
  }

  // Switcher-driven tenant resolution for /book and /survey on admin host
  // (staff "act on behalf of resident" flows). The downstream wizard reads
  // x-client-id from headers just as it does on a client subdomain —
  // hostname is replaced by the cookie as the resolution input.
  if (isAdmin && (path.startsWith('/book') || path.startsWith('/survey'))) {
    const switcherClientId = request.cookies.get(SWITCHER_COOKIE)?.value
    let resolvedClient: {
      id: string
      slug: string
      contractor_id: string
    } | null = null

    if (switcherClientId) {
      const { data } = await supabase
        .from('client')
        .select('id, slug, contractor_id')
        .eq('id', switcherClientId)
        .eq('is_active', true)
        .maybeSingle()
      if (data) resolvedClient = data
    }

    if (!resolvedClient) {
      // No valid switcher selection — bounce to /admin so the user picks
      // a client first. Beats serving the booking wizard against an
      // empty client_id and getting confusing downstream errors.
      return NextResponse.redirect(new URL('/admin', request.url))
    }

    requestHeaders.set('x-client-id', resolvedClient.id)
    requestHeaders.set('x-client-slug', resolvedClient.slug)
  }

  return forwardCookies(NextResponse.next({ request: { headers: requestHeaders } }))
}

async function handleClientHost(request: NextRequest) {
  const hostname = request.headers.get('host') ?? ''
  const path = request.nextUrl.pathname
  const { supabase, forwardCookies } = makeSupabaseClient(request)

  // --- 1. Resolve tenant from hostname ---
  // Local dev bypass: resolve tenant from LOCAL_DEV_CLIENT_SLUG env var,
  // falling back to first active client by created_at.
  const isLocalDev =
    process.env.NODE_ENV === 'development' &&
    (hostname.startsWith('localhost') || hostname.startsWith('127.0.0.1'))

  let clientQuery = supabase
    .from('client')
    .select('id, slug, contractor_id')
    .eq('is_active', true)

  if (isLocalDev) {
    const devSlug = process.env.LOCAL_DEV_CLIENT_SLUG
    if (devSlug) {
      clientQuery = clientQuery.eq('slug', devSlug)
    } else {
      clientQuery = clientQuery.order('created_at', { ascending: true }).limit(1)
    }
  } else {
    clientQuery = clientQuery.or(
      `slug.eq.${hostname.split('.')[0]},custom_domain.eq.${hostname}`
    )
  }

  const { data: client, error: clientError } = await clientQuery.single()

  if (clientError) {
    console.error(
      `[proxy] tenant query failed: ${clientError.message} (code=${clientError.code})`
    )
  }
  if (DEBUG_PROXY) {
    console.log(
      `[proxy] tenant resolution: isLocalDev=${isLocalDev} client=${client ? client.slug : 'null'}`
    )
  }

  if (!client) {
    return new NextResponse('Not Found', { status: 404 })
  }

  // --- 2. Refresh Supabase auth session ---
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // --- 3. Route guards — /admin and /field are gone from client subdomains
  // (redirected before reaching this branch), so guards here are for
  // resident/staff surfaces only.
  if (path.startsWith('/dashboard') || path.startsWith('/booking')) {
    if (!user) {
      return NextResponse.redirect(new URL('/auth', request.url))
    }
  }
  // /book/* and /survey/* are public — no guard

  // --- 4. Forward tenant info as request headers for server components/actions ---
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-client-id', client.id)
  requestHeaders.set('x-client-slug', client.slug)
  requestHeaders.set('x-contractor-id', client.contractor_id)

  return forwardCookies(NextResponse.next({ request: { headers: requestHeaders } }))
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
