// Stale-bundle self-heal (ADR 0010, ADR 0023).
//
// Crews and council staff keep Verco open for days — a crew phone on the run
// sheet, an admin tab left on the bookings list. Every deploy (typically
// several a week) leaves those documents running a JS bundle the new server
// no longer matches: server-action calls 404 (`UnrecognizedActionError`) and
// the UI reports "No connection" for a request that was never going to work
// until the page reloaded (03/08/2026: every VV bulk closeout was rejected by
// a gate the stale bundle couldn't satisfy).
//
// The bundle's build-time SHA is compared with the running server's
// (/api/health) and the document hard-reloads once per server SHA on mismatch.

export const SHA_CHECK_THROTTLE_MS = 5 * 60_000
const RELOADED_FOR_KEY = 'verco-reloaded-for-sha'

/** Browser globals, injectable so the logic is unit-testable under jsdom. */
export interface BundleCheckDeps {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  reload?: () => void
}

/**
 * Compare this bundle's SHA with the server's and hard-reload on mismatch.
 * Resolves true when a reload was triggered. Never throws — offline or a
 * flaky signal just means the next check retries.
 */
export async function reloadIfBundleStale(deps: BundleCheckDeps = {}): Promise<boolean> {
  // Read at call time (not module load) so tests can stub it; Next inlines
  // the literal `process.env.NEXT_PUBLIC_*` reference at build either way.
  const bundleSha = process.env.NEXT_PUBLIC_GIT_SHA
  if (!bundleSha) return false // dev / non-release build — nothing to compare
  // `fetch` must be called as a method of the window (detached = "Illegal
  // invocation" in browsers), hence the arrow rather than `deps.fetch ?? fetch`.
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init))
  const storage = deps.storage ?? sessionStorage
  const reload = deps.reload ?? (() => window.location.reload())
  try {
    const res = await fetchImpl('/api/health', { cache: 'no-store' })
    const { sha } = (await res.json()) as { sha?: string }
    if (!sha || sha === 'unknown' || sha === bundleSha) return false
    // One attempt per server SHA — if a reload somehow still mismatches
    // (rolling deploy mid-flight), don't loop the phone.
    if (storage.getItem(RELOADED_FOR_KEY) === sha) return false
    storage.setItem(RELOADED_FOR_KEY, sha)
    reload()
    return true
  } catch {
    return false
  }
}

let lastCheckedAt = 0

/**
 * Throttled entry point shared by every caller in the document (run-sheet
 * focus hook, per-navigation `BundleFreshness`), so a surface that mounts
 * both doesn't hit /api/health twice. `minIntervalMs: 0` forces a check.
 */
export async function checkBundleFreshness({
  minIntervalMs = SHA_CHECK_THROTTLE_MS,
  ...deps
}: { minIntervalMs?: number } & BundleCheckDeps = {}): Promise<boolean> {
  const now = Date.now()
  if (minIntervalMs > 0 && now - lastCheckedAt < minIntervalMs) return false
  lastCheckedAt = now
  return reloadIfBundleStale(deps)
}
