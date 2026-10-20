// Mirrored: supabase/functions/_shared/post-retry.ts → src/lib/notifications/post-retry.ts
// (scripts/sync-mirrors.sh — edit the _shared copy). Dependency-free on purpose:
// the browser bundle imports it (admin ticket reply → notify-ticket-response),
// so it must not pull in the dispatcher or the email templates.
//
// The retry loop every notification hop shares (#664, #671):
//   - Retries transient failures (429/502/503/504 or a thrown fetch) twice,
//     backing off 500 ms then 1,500 ms. Safe only because the receiving EF
//     CLAIMS the send before making it (a `queued` row under
//     notification_log_send_claim_key) — a retry that lands while the first
//     attempt is still sending is skipped, never sent twice.
//   - A 429 / RateLimitError waits the retry-after it was given (never less
//     than the backoff). One longer than MAX_RATE_LIMIT_WAIT_MS isn't waited
//     out — someone is waiting on the caller — and is returned as the failure.
//   - Never throws.

/** Backoff before retry 1 and retry 2 (ms). Two retries → three attempts. */
export const RETRY_DELAYS_MS: readonly number[] = [500, 1500]

/** Gateway / throttle statuses worth a retry. Anything else is final. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504])

/** Per-attempt cap so a hung gateway can't hold the caller to the 150 s edge limit. */
export const ATTEMPT_TIMEOUT_MS = 10_000

/** Longest throttle wait worth holding the caller for. */
export const MAX_RATE_LIMIT_WAIT_MS = 5_000

export type FailedAttempt =
  | { kind: 'http'; status: number; body: string; retryAfterMs: number | null }
  | { kind: 'thrown'; error: string; retryAfterMs: number | null }

export type PostOutcome =
  | { ok: true; attempts: number; body: string }
  | { ok: false; attempts: number; last: FailedAttempt; throttledWaitMs?: number }

export interface PostWithRetryDeps {
  url: string
  bearer: string
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  /** Names the hop in retry log lines, e.g. `send-notification booking_created <id>`. */
  label: string
}

/**
 * The edge runtime's EF→EF throttle (CLAUDE.md §11) throws a `RateLimitError`
 * with `retryAfterMs`. Duck-typed on `name`; same parse as
 * `rateLimitRetryAfterMs` in _shared/schedule-transition.ts (a separate mirror
 * tree, so not importable from here).
 */
function thrownRetryAfterMs(err: unknown): number | null {
  if (!(err instanceof Error) || err.name !== 'RateLimitError') return null
  const declared = (err as Error & { retryAfterMs?: unknown }).retryAfterMs
  if (typeof declared === 'number' && declared > 0) return declared
  const parsed = /Retry after (\d+)\s*ms/i.exec(err.message)
  return parsed ? Number(parsed[1]) : 60_000
}

/** `Retry-After` in seconds (the HTTP-date form is treated as unknown). */
function headerRetryAfterMs(res: Response): number | null {
  const seconds = Number(res.headers.get('retry-after'))
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
}

export function describeAttempt(a: FailedAttempt): string {
  return a.kind === 'http' ? `returned HTTP ${a.status}` : `threw (${a.error})`
}

async function attemptOnce(
  payload: unknown,
  deps: PostWithRetryDeps,
): Promise<{ kind: 'ok'; body: string } | FailedAttempt> {
  try {
    const res = await deps.fetch(deps.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    })
    const body = await res.text().catch(() => '')
    if (res.ok) return { kind: 'ok', body }
    return {
      kind: 'http',
      status: res.status,
      body: body.slice(0, 500),
      retryAfterMs: res.status === 429 ? headerRetryAfterMs(res) : null,
    }
  } catch (err) {
    return {
      kind: 'thrown',
      error: err instanceof Error ? err.message : String(err),
      retryAfterMs: thrownRetryAfterMs(err),
    }
  }
}

export async function postWithRetry(payload: unknown, deps: PostWithRetryDeps): Promise<PostOutcome> {
  for (let attempt = 1; ; attempt++) {
    const last = await attemptOnce(payload, deps)
    if (last.kind === 'ok') return { ok: true, attempts: attempt, body: last.body }

    const retryable = last.kind === 'thrown' || RETRYABLE_STATUSES.has(last.status)
    const backoff = RETRY_DELAYS_MS[attempt - 1]
    if (!retryable || backoff === undefined) return { ok: false, attempts: attempt, last }

    const wait = Math.max(backoff, last.retryAfterMs ?? 0)
    if (wait > MAX_RATE_LIMIT_WAIT_MS) return { ok: false, attempts: attempt, last, throttledWaitMs: wait }

    console.warn(
      `[notifications] ${deps.label}: ${describeAttempt(last)} — retry ${attempt}/${RETRY_DELAYS_MS.length} in ${wait}ms`,
    )
    await deps.sleep(wait)
  }
}
