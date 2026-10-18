// Pure post-login return-path helper — no `next/headers`, so the proxy, the
// auth pages and the tests can all share it.

const BASE = 'https://verco.invalid'

/**
 * Validates the post-login return path carried in `?next=` (VER-316: an
 * expired session must not drop the caller's number on the Teams lookup).
 *
 * The value is user-controllable, so it is accepted only when it resolves to a
 * path on the current host. Rejected: absolute and protocol-relative URLs,
 * backslashes (browsers read `\` as `/`), and anything the URL parser resolves
 * off-origin (it silently strips tabs/newlines, so `/\t/evil` becomes `//evil`).
 * Returns the parsed path + query + hash, never the raw input.
 */
export function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.includes('\\')) {
    return null
  }
  let url: URL
  try {
    url = new URL(raw, BASE)
  } catch {
    return null
  }
  if (url.origin !== BASE) return null
  return `${url.pathname}${url.search}${url.hash}`
}

/** `/auth`, carrying the page to return to after sign-in when there is one. */
export function loginPath(next: string | null): string {
  return next ? `/auth?${new URLSearchParams({ next })}` : '/auth'
}
