import type { Metadata } from 'next'

/**
 * Map a client's `favicon_url` to a Next.js metadata `icons` value.
 *
 * Returns `undefined` when the client has no favicon, so the caller's
 * `{ icons: undefined }` lets Next fall back to the default `app/icon.png`
 * (the Verco mark). The MIME `type` hint is derived from the URL extension
 * (query string / hash stripped first), defaulting to `image/png` for
 * anything that isn't an explicit `.svg`.
 */
export function faviconToIcons(
  faviconUrl: string | null | undefined,
): Metadata['icons'] {
  if (!faviconUrl) return undefined
  const pathOnly = faviconUrl.split(/[?#]/)[0] ?? ''
  const dot = pathOnly.lastIndexOf('.')
  const ext = dot === -1 ? '' : pathOnly.slice(dot + 1).toLowerCase()
  const type = ext === 'svg' ? 'image/svg+xml' : 'image/png'
  return { icon: [{ url: faviconUrl, type }] }
}
