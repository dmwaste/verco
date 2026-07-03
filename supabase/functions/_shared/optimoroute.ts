/**
 * OptimoRoute REST API v1 client — plan-only integration (EF-only, Deno).
 *
 * Verco pushes orders at T-3 hard close, ops plan routes in the OptimoRoute
 * web UI, Verco pulls the planned sequences back. No driver-app usage, no
 * status feedback to OptimoRoute.
 *
 * API notes (docs v1.36):
 *  - Auth is an API key query param (?key=...).
 *  - Max 5 concurrent requests per account — this client is strictly
 *    sequential.
 *  - Bulk endpoints cap at 500 orders per request.
 *  - create_or_update_orders with operation SYNC is a full create-or-replace
 *    upsert per orderNo, which makes re-pushes idempotent.
 */

const BASE_URL = 'https://api.optimoroute.com/v1'

export const OR_BULK_LIMIT = 500

/**
 * Resolves the routing-engine API key. Single OptimoRoute account (D&M) in
 * v1 — the contractorId param exists so call sites are already shaped for a
 * per-contractor config table later without signature churn.
 */
export function getRoutingApiKey(_contractorId?: string): string {
  const key = Deno.env.get('OPTIMOROUTE_API_KEY')
  if (!key) {
    throw new Error('OPTIMOROUTE_API_KEY is not set (Supabase EF secret)')
  }
  return key
}

export interface OrOrderInput {
  orderNo: string
  date: string // YYYY-MM-DD
  duration: number // minutes
  priority: 'L' | 'M' | 'H' | 'C'
  /** Required vehicle-feature codes — router only assigns to a matching vehicle. */
  vehicleFeatures?: string[]
  notes?: string
  location: {
    address?: string
    locationName?: string
    latitude?: number
    longitude?: number
    acceptPartialMatch?: boolean
  }
}

export interface OrOrderResult {
  orderNo: string
  success: boolean
  error?: string
}

export interface OrRouteStop {
  stopNumber: number
  orderNo?: string
  scheduledAt?: string // "HH:MM" local to the OR account timezone
  address?: string
  locationName?: string
  latitude?: number
  longitude?: number
  /** "depot" / "break" for non-order stops; absent for order stops */
  type?: string
}

export interface OrRoute {
  driverSerial: string
  driverName: string
  stops: OrRouteStop[]
}

interface OrBulkResponse {
  success: boolean
  code?: string
  message?: string
  orders?: Array<{ success: boolean; code?: string; message?: string }>
}

/**
 * Network-failure messages from fetch embed the full request URL — which
 * carries the API key as a query param. Every EF's top-level catch returns
 * err.message to (anon-invocable) callers, so rethrow sanitised instead of
 * letting the raw TypeError bubble.
 */
async function safeFetch(
  apiKey: string,
  endpoint: string,
  init?: RequestInit,
  extraQuery = '',
): Promise<Response> {
  try {
    return await fetch(`${BASE_URL}/${endpoint}?key=${encodeURIComponent(apiKey)}${extraQuery}`, init)
  } catch (err) {
    throw new Error(
      `OptimoRoute ${endpoint} request failed: ${err instanceof Error ? err.name : 'network error'}`,
    )
  }
}

async function post(apiKey: string, endpoint: string, body: unknown): Promise<Response> {
  return await safeFetch(apiKey, endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

/**
 * Creates/replaces orders (operation SYNC). Sequential ≤500-order chunks.
 * Returns one result per input order, positionally matched per the API
 * contract.
 */
export async function createOrUpdateOrders(
  apiKey: string,
  orders: OrOrderInput[],
): Promise<OrOrderResult[]> {
  const results: OrOrderResult[] = []

  for (const batch of chunk(orders, OR_BULK_LIMIT)) {
    const res = await post(apiKey, 'create_or_update_orders', {
      orders: batch.map((o) => ({
        operation: 'SYNC',
        orderNo: o.orderNo,
        type: 'P', // pickup
        date: o.date,
        duration: o.duration,
        priority: o.priority,
        vehicleFeatures: o.vehicleFeatures ?? [],
        notes: o.notes,
        location: o.location,
      })),
    })

    if (!res.ok) {
      const text = await res.text()
      for (const o of batch) {
        results.push({ orderNo: o.orderNo, success: false, error: `HTTP ${res.status}: ${text}` })
      }
      continue
    }

    const data = (await res.json()) as OrBulkResponse
    if (!data.success || !data.orders) {
      const error = data.message ?? data.code ?? 'create_or_update_orders failed'
      for (const o of batch) {
        results.push({ orderNo: o.orderNo, success: false, error })
      }
      continue
    }

    batch.forEach((o, i) => {
      const r = data.orders![i]
      results.push({
        orderNo: o.orderNo,
        success: r?.success ?? false,
        error: r?.success ? undefined : (r?.message ?? r?.code ?? 'rejected'),
      })
    })
  }

  return results
}

/**
 * Deletes orders by orderNo. A not-found result counts as success — the order
 * is gone either way, which is the post-condition the sweep cares about.
 * Docs name the code ERR_ORD_NOT_FOUND; ORDER_NOT_FOUND is accepted
 * defensively in case the live API differs from the docs.
 */
export async function deleteOrders(apiKey: string, orderNos: string[]): Promise<OrOrderResult[]> {
  const results: OrOrderResult[] = []

  for (const batch of chunk(orderNos, OR_BULK_LIMIT)) {
    const res = await post(apiKey, 'delete_orders', {
      orders: batch.map((orderNo) => ({ orderNo })),
    })

    if (!res.ok) {
      const text = await res.text()
      for (const orderNo of batch) {
        results.push({ orderNo, success: false, error: `HTTP ${res.status}: ${text}` })
      }
      continue
    }

    const data = (await res.json()) as OrBulkResponse
    if (!data.success || !data.orders) {
      const error = data.message ?? data.code ?? 'delete_orders failed'
      for (const orderNo of batch) {
        results.push({ orderNo, success: false, error })
      }
      continue
    }

    batch.forEach((orderNo, i) => {
      const r = data.orders![i]
      const notFound = r?.code === 'ERR_ORD_NOT_FOUND' || r?.code === 'ORDER_NOT_FOUND'
      results.push({
        orderNo,
        success: (r?.success ?? false) || notFound,
        error: r?.success || notFound ? undefined : (r?.message ?? r?.code ?? 'rejected'),
      })
    })
  }

  return results
}

/**
 * Fetches planned routes for a date. Empty array = nothing planned yet.
 * includeRouteStartEnd adds the route's depot start/end entries to stops[]
 * (type "depot") so the run-sheet header can show them — without it a route
 * with no mid-route reloads would have no depot entries at all.
 */
export async function getRoutes(apiKey: string, date: string): Promise<OrRoute[]> {
  const res = await safeFetch(
    apiKey,
    'get_routes',
    undefined,
    `&date=${encodeURIComponent(date)}&includeRouteStartEnd=true`,
  )
  if (!res.ok) {
    throw new Error(`get_routes(${date}) failed: HTTP ${res.status}: ${await res.text()}`)
  }
  const data = (await res.json()) as { success: boolean; message?: string; routes?: OrRoute[] }
  if (!data.success) {
    throw new Error(`get_routes(${date}) failed: ${data.message ?? 'unknown error'}`)
  }
  return data.routes ?? []
}
