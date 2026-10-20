/**
 * Google Maps web services take the API key as a query parameter, and a
 * network-failure fetch error can embed the full request URL (key AND the
 * resident address being looked up). geocode-properties returns its per-row
 * error strings to every staff role (Add Property and the property edit
 * section show them, #675) and its 500 body goes to Sentry, so a raw TypeError
 * could put the key in front of council staff. Rethrow with the cause kept
 * (DNS, TLS, connection reset) but the URL and key cut out.
 */
export async function googleFetch(url: URL, label: string): Promise<Response> {
  const href = url.toString()
  try {
    return await fetch(href)
  } catch (err) {
    const key = url.searchParams.get('key')
    let cause = err instanceof Error ? err.message || err.name : 'network error'
    cause = cause.replaceAll(href, '[Google URL]')
    if (key) cause = cause.replaceAll(key, '[redacted]')
    throw new Error(`Google ${label} request failed: ${cause}`)
  }
}
