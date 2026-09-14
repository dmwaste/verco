// Stale-bundle self-heal for server actions (ADR 0023).
//
// Next.js already hard-navigates a stale document the moment it soft-navigates
// or calls `router.refresh()` — the client compares the server's build id on
// every RSC response (next/dist/client/components/router-reducer/
// fetch-server-response.js). The gap is a document whose FIRST post-deploy
// interaction is a server action: action ids are salted per build, so the id
// no longer exists on the server, the call 404s and Next throws
// `UnrecognizedActionError` to the caller. It is never a signal problem and no
// retry can succeed until the page reloads, so a catch that reports "No
// connection" strands the crew on a dead button.
//
// `handleStaleAction` reloads once. A second stale failure inside the loop
// window (a rolling deploy still serving the old document, or an action
// genuinely removed) gets a manual "reload the page" message, never a loop.

export type StaleActionOutcome = 'reloading' | 'reload-blocked'

export const STALE_ACTION_MESSAGE: Record<StaleActionOutcome, string> = {
  reloading: 'App updated — reloading…',
  'reload-blocked': 'App updated — reload the page to continue.',
}

export const RELOAD_LOOP_WINDOW_MS = 30_000
const RELOADED_AT_KEY = 'verco-stale-action-reloaded-at'

/** Browser globals, injectable so the logic is unit-testable under jsdom. */
export interface StaleActionDeps {
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  reload?: () => void
  now?: () => number
}

/**
 * Duck-typed on `name` rather than `unstable_isUnrecognizedActionError` from
 * next/navigation so it also works where that module is mocked (tests) and
 * doesn't pin an unstable export. Next sets `name` in the class constructor.
 */
export function isStaleActionError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'UnrecognizedActionError'
  )
}

// In-memory copy of the loop-guard stamp: sessionStorage is the durable copy
// (it survives the reload, which is the point), this one still bounds reloads
// within a document where storage is blocked or throws.
let lastReloadAt = 0

function defaultStorage(): StaleActionDeps['storage'] {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null // storage-blocked browser: the accessor itself throws
  }
}

function readStamp(storage: StaleActionDeps['storage']): number {
  try {
    const raw = storage?.getItem(RELOADED_AT_KEY)
    const stored = raw ? Number(raw) : 0
    return Math.max(Number.isFinite(stored) ? stored : 0, lastReloadAt)
  } catch {
    return lastReloadAt
  }
}

function writeStamp(storage: StaleActionDeps['storage'], at: number): void {
  lastReloadAt = at
  try {
    storage?.setItem(RELOADED_AT_KEY, String(at))
  } catch {
    // quota / private mode — the in-memory stamp still guards this document
  }
}

/**
 * Reload the document once when `err` is a stale-action error. Returns what
 * happened so the caller can show the matching message, or null when the
 * error is something else (the caller's own handling applies). Never throws.
 */
export function handleStaleAction(
  err: unknown,
  deps: StaleActionDeps = {},
): StaleActionOutcome | null {
  if (!isStaleActionError(err)) return null
  const now = deps.now?.() ?? Date.now()
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage
  if (now - readStamp(storage) < RELOAD_LOOP_WINDOW_MS) return 'reload-blocked'
  writeStamp(storage, now)
  ;(deps.reload ?? (() => window.location.reload()))()
  return 'reloading'
}

/**
 * For catch blocks that show the user a message: the stale-action message
 * (after triggering the reload) or null so the caller falls back to its own
 * ("No connection — check signal and retry.").
 */
export function staleActionMessage(err: unknown, deps?: StaleActionDeps): string | null {
  const outcome = handleStaleAction(err, deps)
  return outcome ? STALE_ACTION_MESSAGE[outcome] : null
}
