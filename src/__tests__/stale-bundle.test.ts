import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isStaleActionError, reloadIfStaleAction } from '@/lib/bundle/stale-action'

/**
 * Stale-bundle self-heal (ADR 0023). A crew phone or admin tab left open
 * across a deploy runs a bundle the server no longer matches — its server
 * actions 404 and the UI used to blame the phone signal. These guard the
 * /api/health SHA comparison and the stale-action reload path.
 */

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  }
}

function healthFetch(sha: string) {
  return vi.fn(async () => ({ json: async () => ({ sha }) }) as unknown as Response)
}

async function loadLib() {
  vi.resetModules() // fresh module-level throttle state per test
  return import('@/lib/bundle/reload-if-stale')
}

describe('reloadIfBundleStale', () => {
  beforeEach(() => vi.stubEnv('NEXT_PUBLIC_GIT_SHA', 'bundle-aaa'))
  afterEach(() => vi.unstubAllEnvs())

  it('reloads once when the server SHA differs from the bundle SHA', async () => {
    const { reloadIfBundleStale } = await loadLib()
    const reload = vi.fn()
    const storage = memoryStorage()
    const fetch = healthFetch('server-bbb')

    expect(await reloadIfBundleStale({ fetch, storage, reload })).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('/api/health', { cache: 'no-store' })

    // Same server SHA again (rolling deploy mid-flight) — never loop the phone.
    expect(await reloadIfBundleStale({ fetch, storage, reload })).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the SHAs match', async () => {
    const { reloadIfBundleStale } = await loadLib()
    const reload = vi.fn()
    expect(
      await reloadIfBundleStale({ fetch: healthFetch('bundle-aaa'), storage: memoryStorage(), reload }),
    ).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it.each(['unknown', ''])('does nothing when the server reports sha=%j', async (sha) => {
    const { reloadIfBundleStale } = await loadLib()
    const reload = vi.fn()
    expect(
      await reloadIfBundleStale({ fetch: healthFetch(sha), storage: memoryStorage(), reload }),
    ).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('swallows a failed health fetch (offline) and does not reload', async () => {
    const { reloadIfBundleStale } = await loadLib()
    const reload = vi.fn()
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await reloadIfBundleStale({ fetch, storage: memoryStorage(), reload })).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('never fetches on a non-release build (no bundle SHA)', async () => {
    vi.stubEnv('NEXT_PUBLIC_GIT_SHA', '')
    const { reloadIfBundleStale } = await loadLib()
    const fetch = healthFetch('server-bbb')
    const reload = vi.fn()
    expect(await reloadIfBundleStale({ fetch, storage: memoryStorage(), reload })).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('checkBundleFreshness (throttled)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_GIT_SHA', 'bundle-aaa')
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('checks at most once per interval, then again once the interval has passed', async () => {
    const { checkBundleFreshness, SHA_CHECK_THROTTLE_MS } = await loadLib()
    const fetch = healthFetch('bundle-aaa')
    const deps = { fetch, storage: memoryStorage(), reload: vi.fn() }

    await checkBundleFreshness(deps) // first call always runs
    await checkBundleFreshness(deps) // within the window — skipped
    expect(fetch).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(SHA_CHECK_THROTTLE_MS)
    await checkBundleFreshness(deps)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('minIntervalMs: 0 forces a check', async () => {
    const { checkBundleFreshness } = await loadLib()
    const fetch = healthFetch('bundle-aaa')
    const deps = { fetch, storage: memoryStorage(), reload: vi.fn() }
    await checkBundleFreshness(deps)
    await checkBundleFreshness({ ...deps, minIntervalMs: 0 })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('stale server-action errors', () => {
  // Mirrors next/dist/client/components/unrecognized-action-error.js — the
  // class sets `name` in its constructor; we duck-type on that.
  class UnrecognizedActionError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'UnrecognizedActionError'
    }
  }

  it('recognises UnrecognizedActionError and nothing else', () => {
    expect(isStaleActionError(new UnrecognizedActionError('Server Action "abc" was not found'))).toBe(true)
    expect(isStaleActionError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isStaleActionError('UnrecognizedActionError')).toBe(false)
    expect(isStaleActionError(null)).toBe(false)
    expect(isStaleActionError(undefined)).toBe(false)
  })

  it('reloads for a stale action and tells the caller to stop', () => {
    const reload = vi.fn()
    expect(reloadIfStaleAction(new UnrecognizedActionError('gone'), reload)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('leaves a genuine network error to the caller ("No connection" path)', () => {
    const reload = vi.fn()
    expect(reloadIfStaleAction(new TypeError('Failed to fetch'), reload)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})
