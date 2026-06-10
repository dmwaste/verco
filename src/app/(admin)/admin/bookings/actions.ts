'use server'

import { createClient } from '@/lib/supabase/server'
import type { Result } from '@/lib/result'

export interface RefreshRoutesSummary {
  stopsStamped: number
  stopsUnplanned: number
  routesSeen: number
}

/**
 * Manual "Refresh routes" — invokes the pull-optimoroute-routes Edge
 * Function with the staff user's JWT (the EF's dual auth accepts
 * contractor-admin/contractor-staff alongside the cron's routing bearer).
 * Lets ops pull a fresh plan immediately after finishing it in the routing
 * engine instead of waiting for the 4-hourly cron tick.
 *
 * Direct fetch() per CLAUDE.md §11 — supabase.functions.invoke is
 * unreliable in SSR.
 */
export async function refreshRoutes(): Promise<Result<RefreshRoutesSummary>> {
  const supabase = await createClient()

  const { data: role } = await supabase.rpc('current_user_role')
  if (!role || !['contractor-admin', 'contractor-staff'].includes(role)) {
    return { ok: false, error: 'Insufficient permissions to refresh routes.' }
  }

  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session?.access_token) {
    return { ok: false, error: 'No active session.' }
  }

  const res = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/pull-optimoroute-routes`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
    },
  )

  const body = (await res.json().catch(() => null)) as {
    ok?: boolean
    error?: string
    stops_stamped?: number
    stops_unplanned?: number
    routes_seen?: number
  } | null

  if (!res.ok || !body?.ok) {
    return {
      ok: false,
      error: body?.error ?? `Route refresh failed (HTTP ${res.status}).`,
    }
  }

  return {
    ok: true,
    data: {
      stopsStamped: body.stops_stamped ?? 0,
      stopsUnplanned: body.stops_unplanned ?? 0,
      routesSeen: body.routes_seen ?? 0,
    },
  }
}
