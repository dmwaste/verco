/**
 * Resolves the client an admin "acts on behalf of" when opening the resident
 * booking/survey wizard from the admin host (`/book`, `/survey`).
 *
 * Mirrors `getCurrentAdminClient()` tiers 1 + 3 (src/lib/admin/current-client.ts):
 *   1. the explicit switcher selection (the `verco_admin_client` cookie)
 *   3. the user's first accessible active client
 * (tier 2 — the `x-client-id` header — is skipped here because the proxy is the
 * thing that sets that header.)
 *
 * Returns `null` only when the user has no accessible active client, in which
 * case the proxy bounces to `/admin`. Keeping this in lockstep with
 * `getCurrentAdminClient()` is what stops the proxy and the admin UI from
 * disagreeing about whether a booking can start: without the tier-3 fallback a
 * first-visit admin (switcher cookie not yet written) was silently bounced from
 * the "+ New Booking" CTA even though the admin UI happily defaults to a client
 * (VER-233).
 */
export interface OnBehalfClient {
  id: string
  slug: string
  contractor_id: string
}

export async function resolveOnBehalfClient(
  switcherClientId: string | undefined,
  lookupById: (id: string) => Promise<OnBehalfClient | null>,
  firstAccessible: () => Promise<OnBehalfClient | null>,
): Promise<OnBehalfClient | null> {
  if (switcherClientId) {
    const byId = await lookupById(switcherClientId)
    if (byId) return byId
  }
  return firstAccessible()
}
