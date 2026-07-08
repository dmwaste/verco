export function formatCurrency(cents: number): string {
  const dollars = cents / 100
  return dollars.toLocaleString('en-AU', {
    style: 'currency',
    currency: 'AUD',
  })
}

export function formatCollectionDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00+08:00`)
  return date.toLocaleDateString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Australia/Perth',
  })
}

/**
 * Compact AU collection date for SMS bodies. Drops the year (year is implied
 * within the same FY) and the comma — every char counts in a 160-char
 * segment. Example: "Wed 20 May".
 */
export function formatCollectionDateShort(iso: string): string {
  const date = new Date(`${iso}T00:00:00+08:00`)
  return date.toLocaleDateString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Australia/Perth',
  })
}

/**
 * Build the SMS canonical link for a booking — `verco.au/b/<ref>`.
 * Resolved by the root-host proxy via `resolve_booking_redirect` RPC, which
 * 302s the recipient to their tenant's `/booking/<ref>` page.
 *
 * Stable across tenant rebrands: if WMRC ever migrates off vvtest.verco.au,
 * historic SMS links still resolve because the lookup is by ref → live
 * tenant subdomain, not encoded into the URL.
 */
export function buildSmsBookingLink(ref: string): string {
  return `verco.au/b/${encodeURIComponent(ref)}`
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Shape-only photo filter at the dispatch layer: only https URLs containing
 * the public Supabase storage path render into resident-facing emails. This
 * is defence-in-depth, NOT the authoritative check — it is env-free (mirrored
 * to Deno + Node) so it cannot pin the host, and a hostile host serving a
 * /storage/v1/object/public/ path would pass. The authoritative full-host
 * validation lives at every capture site (closeout zod schemas check
 * `${SUPABASE_URL}/storage/v1/object/public/`); any future notification
 * producer that forwards user-supplied photos must do the same.
 */
export function sanitizePhotoUrls(photos: string[] | undefined): string[] {
  return (photos ?? []).filter(
    (url) => url.startsWith('https://') && url.includes('/storage/v1/object/public/'),
  )
}

/**
 * Inline rendition for the email `<img src>`: routes public storage objects
 * through the Supabase image transformation endpoint at 1072px/q75 (retina 2×
 * of the 536px content slot — verified supported on prod 08/07/2026, a real
 * closeout photo went 421KB → 232KB; savings grow with multi-MB phone shots).
 * The wrapping `<a href>` keeps the full-resolution original. Non-storage URLs
 * (e.g. the admin preview's data URIs) pass through unchanged.
 */
export function emailPhotoRenditionUrl(url: string): string {
  const marker = '/storage/v1/object/public/'
  if (!url.startsWith('https://') || !url.includes(marker)) return url
  const rendered = url.replace(marker, '/storage/v1/render/image/public/')
  return `${rendered}${rendered.includes('?') ? '&' : '?'}width=1072&quality=75`
}

/**
 * Up to 4 crew evidence photos for NCN/NP notice emails, each an inline `<img>`
 * (NOT a CSS `background-image` — Gmail and Outlook strip that, leaving an empty
 * box) wrapped in a link to the full-resolution file. Photo URLs are the public
 * Supabase storage URLs captured at closeout; escaped as HTML attribute values.
 * Returns '' when there are no photos so the caller can inline it unconditionally.
 *
 * Outlook desktop (Word renderer) ignores CSS width/max-width and computes a
 * PERCENTAGE width attribute against the image's natural pixel size — so a
 * fixed `width="536"` attribute (600px container − 2×32px body padding) is the
 * only thing stopping a 4000px phone photo from blowing out the layout there.
 * Modern clients follow the fluid CSS instead.
 */
export function renderPhotoBlock(photos: string[] | undefined): string {
  const visible = (photos ?? []).slice(0, 4)
  if (visible.length === 0) return ''
  const items = visible
    .map((url, i) => {
      const full = escapeHtml(url)
      const rendition = escapeHtml(emailPhotoRenditionUrl(url))
      const alt = `Collection photo ${i + 1} of ${visible.length} — tap to view full size`
      return `<a href="${full}" target="_blank" style="display:block;margin:0 0 8px 0"><img src="${rendition}" alt="${alt}" width="536" border="0" style="width:100%;max-width:536px;height:auto;border-radius:4px;display:block;border:1px solid #E6EAED" /></a>`
    })
    .join('')
  return `<div style="margin:0 0 16px 0">${items}</div>`
}

/**
 * Build a resolvable booking-portal URL for an email CTA.
 *
 * Verco uses **hostname-based tenant routing** — every client has its own
 * subdomain (`vvtest.verco.au`, `kwntest.verco.au`, …). Concatenating
 * `${appUrl}/${slug}/...` produces a broken link because `verco.au` doesn't
 * have a `/vergevalet/` path route. The proper booking-detail URL is
 * `https://<client-hostname>/booking/<ref>`.
 *
 * Resolution order:
 *   1. `client.custom_domain` if set (the actual prod / UAT host)
 *   2. `https://{slug}.verco.au` (works once DNS is wildcard-set for slugs)
 *   3. `appUrl + path` as a last-resort fallback (better than nothing)
 *
 * @param client  BookingClientForDispatch row from the dispatcher
 * @param path    URL path including leading slash (e.g. `/booking/ABC123`)
 * @param appUrl  Final fallback when neither custom_domain nor slug yield
 *                a working host (shouldn't happen for active clients).
 */
export function buildBookingPortalUrl(
  client: { slug: string; custom_domain: string | null },
  path: string,
  appUrl: string,
): string {
  if (client.custom_domain) {
    return `https://${client.custom_domain}${path}`
  }
  if (client.slug) {
    return `https://${client.slug}.verco.au${path}`
  }
  return `${appUrl}${path}`
}
