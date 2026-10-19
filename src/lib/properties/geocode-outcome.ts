import type { Result } from '@/lib/result'

/**
 * Reading `geocode-properties` results for the admin UI.
 *
 * A property with no map pin can't go into the crews' OptimoRoute routes (the
 * bulk push can't geocode — #673). Google's answer is often refused on purpose
 * (`verifyGeocodeResult`: wrong suburb, interstate, suburb-only), and staff
 * must be told when that happens. Before this, Add Property started a queue-wide
 * loop, never looked up its own row, and hid the refusal: 13 cronin way anketel
 * sat unpinned for four days until its booking stalled the 22/10 push.
 */

/** The parts of a geocode-properties response the admin UI reads. */
export interface GeocodeEfResponse {
  total?: number
  processed?: number
  failed?: number
  rejected?: number
  /** Coordinates written, google_place_id left NULL, so the row stays in the queue (#508). */
  snapped?: number
  errors?: Array<{ id: string; error: string }>
  rejected_samples?: Array<{ id: string; address: string; google: string; reason: string }>
}

export type PropertyGeocodeOutcome =
  | { kind: 'pinned' }
  | { kind: 'rejected'; google: string; reason: string }
  | { kind: 'failed'; error: string }

/**
 * The EF's response body. It answers HTTP 500 whenever any row failed (so a
 * cron sees the failure), and `invokeEfWithUserToken` returns that as an error
 * string. That body is still the run summary, so read it from there too.
 */
function efSummary(res: Result<GeocodeEfResponse>): GeocodeEfResponse | null {
  if (res.ok) return res.data ?? null
  const body = parseJson(res.error)
  return body && typeof body.processed === 'number' ? (body as GeocodeEfResponse) : null
}

/** A readable message for a failed EF call: `{ error }` bodies unwrapped. */
function efErrorText(error: string): string {
  const body = parseJson(error)
  return typeof body?.error === 'string' ? body.error : error
}

function parseJson(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The outcome for ONE property geocoded with `{ property_ids: [propertyId] }`. */
export function propertyGeocodeOutcome(
  propertyId: string,
  res: Result<GeocodeEfResponse>,
): PropertyGeocodeOutcome {
  const body = efSummary(res)
  if (!body) {
    return { kind: 'failed', error: res.ok ? 'no response from the map lookup' : efErrorText(res.error) }
  }
  const rejected = body.rejected_samples?.find((s) => s.id === propertyId)
  if (rejected) return { kind: 'rejected', google: rejected.google, reason: rejected.reason }
  if ((body.processed ?? 0) > 0) return { kind: 'pinned' }
  const error = body.errors?.find((e) => e.id === propertyId)?.error
  if (error) return { kind: 'failed', error }
  return { kind: 'failed', error: 'the map lookup did not find this property' }
}

/**
 * Why Google's match was refused and what to fix. Shared by Add Property and
 * the property page's address edit so staff get the same advice in both places.
 */
export function rejectionExplanation(google: string, reason: string): string {
  switch (reason) {
    case 'locality':
      return `Google matched it to "${google}", a different suburb, so that location wasn't used. Check the spelling of the street and suburb and add the postcode.`
    case 'state':
      return `Google matched it to "${google}", interstate, so that location wasn't used. Add the suburb and postcode.`
    case 'granularity':
      return `Google could only find "${google}", not the street itself, so no location was used. Check the street name and number. If they're right, the street may be too new for Google Maps.`
    default:
      return `Google matched it to "${google}", so that location wasn't used.`
  }
}

export interface GeocodeQueueSummary {
  /** Rows fully geocoded (pin + Google identity) and gone from the queue. */
  geocoded: number
  /** Rows still unpinned because Google's match was refused. */
  rejected: number
  /** Rows still unpinned because the lookup errored. */
  failed: number
}

/**
 * Drives `geocode-properties { limit }` over the whole un-geocoded queue in
 * chunks (the EF has a ~150s wall clock). Stops as soon as a call saw the whole
 * queue or moved nothing out of it. Snapped rows stay in the queue by design,
 * so "processed > 0" is not progress. Treating it as progress kept the old
 * loop going for 100 calls per click and hid every refused address.
 */
export async function runGeocodeQueue(
  invoke: (body: { limit: number }) => Promise<Result<GeocodeEfResponse>>,
  {
    chunk = 500,
    maxIterations = 100,
    onProgress,
  }: { chunk?: number; maxIterations?: number; onProgress?: (geocoded: number) => void } = {},
): Promise<Result<GeocodeQueueSummary>> {
  let geocoded = 0
  let last: GeocodeEfResponse = {}
  for (let i = 0; i < maxIterations; i++) {
    const res = await invoke({ limit: chunk })
    const body = efSummary(res)
    if (!body) return { ok: false, error: res.ok ? 'no response from the map lookup' : efErrorText(res.error) }
    last = body
    const leftQueue = (body.processed ?? 0) - (body.snapped ?? 0)
    geocoded += Math.max(0, leftQueue)
    if ((body.total ?? 0) < chunk || leftQueue <= 0) break
    onProgress?.(geocoded)
  }
  return { ok: true, data: { geocoded, rejected: last.rejected ?? 0, failed: last.failed ?? 0 } }
}
