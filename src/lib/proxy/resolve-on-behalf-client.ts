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
 *
 * Security — `accessibleIds` is REQUIRED, and both tiers are gated on it.
 * The `client` table is public-SELECT (RLS `USING (is_active = true)`) so the
 * unauthenticated /book flow can read it. RLS therefore scopes NOTHING here: a
 * lookup filtered only by `is_active` sees every active tenant. The original
 * implementation relied on RLS to hide inaccessible clients, so its tier-3
 * "first accessible client" was really "first active client in the whole
 * table, ordered by name" — which resolved every cookie-less admin to
 * "City of Kwinana" (alphabetically first). A Verge Valet staffer opening
 * "+ New Booking" got `x-client-id` = City of Kwinana, and their resident's
 * address came back "not eligible for VERCO Kwinana". Callers must pass the
 * ids from `accessible_client_ids()` and scope their queries to the same set.
 */
export interface OnBehalfClient {
  id: string
  slug: string
  contractor_id: string
}

export async function resolveOnBehalfClient(
  switcherClientId: string | undefined,
  accessibleIds: string[],
  lookupById: (id: string) => Promise<OnBehalfClient | null>,
  firstAccessible: () => Promise<OnBehalfClient | null>,
): Promise<OnBehalfClient | null> {
  // Fail closed: no accessible client means no booking can start, and an empty
  // set must never be read as "unfiltered".
  if (accessibleIds.length === 0) return null

  // Honour the switcher cookie only when it names a client the user may act
  // as, so a stale or tampered cookie falls through to the accessible default
  // instead of scoping the wizard into another tenant.
  if (switcherClientId && accessibleIds.includes(switcherClientId)) {
    const byId = await lookupById(switcherClientId)
    if (byId) return byId
  }

  // Post-condition, not belt-and-braces theatre: callers inject the queries, so
  // the tier-3 fallback is only as scoped as the SQL behind it — and that is
  // precisely what regressed (an unscoped `client` read resolved everyone to
  // the alphabetically-first tenant). Re-checking the result here means a
  // caller that forgets `.in('id', accessibleIds)` fails closed instead of
  // silently handing the wizard another tenant.
  const fallback = await firstAccessible()
  if (fallback && !accessibleIds.includes(fallback.id)) return null
  return fallback
}
