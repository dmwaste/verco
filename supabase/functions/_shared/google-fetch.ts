/**
 * Google Maps web services take the API key as a query parameter, and a
 * network-failure fetch error can embed the full request URL. geocode-properties
 * returns its per-row error strings to every staff role (Add Property and the
 * property edit section show them, #675) and its 500 body goes to Sentry, so a
 * raw TypeError could put the key in front of council staff. Rethrow with the
 * error's name only — same class as `safeFetch` in `optimoroute.ts`.
 */
export async function googleFetch(url: URL, label: string): Promise<Response> {
  try {
    return await fetch(url.toString())
  } catch (err) {
    throw new Error(
      `Google ${label} request failed: ${err instanceof Error ? err.name : 'network error'}`,
    )
  }
}
