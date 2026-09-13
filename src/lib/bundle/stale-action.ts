// A server-action call from a bundle the server no longer knows gets a 404
// and Next throws `UnrecognizedActionError` on the client (deploy skew —
// nextjs.org/docs/messages/failed-to-find-server-action). It is never a
// signal problem and no retry can succeed until the page reloads, so a catch
// that reports "No connection" strands the crew on a dead button (ADR 0023).

/**
 * Duck-typed on `name` rather than `unstable_isUnrecognizedActionError` from
 * next/navigation so it also works where that module is mocked (tests) and
 * doesn't pin an unstable export.
 */
export function isStaleActionError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'UnrecognizedActionError'
  )
}

/**
 * Reload the document when `err` is a stale-action error. Returns true when
 * it did — the caller should stop (no "No connection" message, no retry).
 */
export function reloadIfStaleAction(
  err: unknown,
  reload: () => void = () => window.location.reload(),
): boolean {
  if (!isStaleActionError(err)) return false
  reload()
  return true
}
