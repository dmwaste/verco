import { describe, it, expect, vi, beforeEach } from 'vitest'
// The real class Next throws (next/dist is not a public path, but it is the
// only way to prove the duck-typing matches what production receives).
import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error'

/**
 * Stale-bundle self-heal for server actions (ADR 0023). A crew phone or admin
 * tab left open across a deploy runs a bundle whose action ids the server no
 * longer knows; the first save throws UnrecognizedActionError. These guard
 * the once-per-window reload and the messages the catch sites show.
 */

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  }
}

function throwingStorage() {
  return {
    getItem: (): string | null => {
      throw new DOMException('denied', 'SecurityError')
    },
    setItem: (): void => {
      throw new DOMException('denied', 'SecurityError')
    },
  }
}

async function loadLib() {
  vi.resetModules() // fresh in-memory loop-guard stamp per test
  return import('@/lib/bundle/stale-action')
}

const stale = () => new UnrecognizedActionError('Server Action "abc" was not found on the server.')

describe('isStaleActionError', () => {
  it("recognises Next's UnrecognizedActionError and nothing else", async () => {
    const { isStaleActionError } = await loadLib()
    expect(isStaleActionError(stale())).toBe(true)
    expect(isStaleActionError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isStaleActionError('UnrecognizedActionError')).toBe(false)
    expect(isStaleActionError(null)).toBe(false)
    expect(isStaleActionError(undefined)).toBe(false)
  })
})

describe('handleStaleAction', () => {
  let reload: ReturnType<typeof vi.fn>
  beforeEach(() => {
    reload = vi.fn()
  })

  it('leaves a genuine network error to the caller', async () => {
    const { handleStaleAction, staleActionMessage } = await loadLib()
    const deps = { storage: memoryStorage(), reload, now: () => 1_000_000 }
    expect(handleStaleAction(new TypeError('Failed to fetch'), deps)).toBeNull()
    expect(staleActionMessage(new TypeError('Failed to fetch'), deps)).toBeNull()
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads once and stamps the time so the reloaded document knows', async () => {
    const { handleStaleAction } = await loadLib()
    const storage = memoryStorage()
    expect(handleStaleAction(stale(), { storage, reload, now: () => 1_000_000 })).toBe('reloading')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(storage.getItem('verco-stale-action-reloaded-at')).toBe('1000000')
  })

  it('does not loop: a second stale failure inside the window is blocked, after it reloads again', async () => {
    const { handleStaleAction, RELOAD_LOOP_WINDOW_MS } = await loadLib()
    const storage = memoryStorage()
    let t = 1_000_000
    const deps = { storage, reload, now: () => t }

    expect(handleStaleAction(stale(), deps)).toBe('reloading')
    t += RELOAD_LOOP_WINDOW_MS - 1
    expect(handleStaleAction(stale(), deps)).toBe('reload-blocked')
    expect(reload).toHaveBeenCalledTimes(1)

    t += 1
    expect(handleStaleAction(stale(), deps)).toBe('reloading')
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('honours a stamp written before the reload (same tab, old document served again)', async () => {
    const { handleStaleAction } = await loadLib()
    const storage = memoryStorage()
    storage.setItem('verco-stale-action-reloaded-at', '1000000') // written by the previous document
    expect(handleStaleAction(stale(), { storage, reload, now: () => 1_005_000 })).toBe('reload-blocked')
    expect(reload).not.toHaveBeenCalled()
  })

  it('still reloads once, and never throws, when storage is blocked', async () => {
    const { handleStaleAction } = await loadLib()
    const deps = { storage: throwingStorage(), reload, now: () => 1_000_000 }
    expect(handleStaleAction(stale(), deps)).toBe('reloading')
    expect(handleStaleAction(stale(), deps)).toBe('reload-blocked') // in-memory stamp
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('treats storage: null like blocked storage', async () => {
    const { handleStaleAction } = await loadLib()
    const deps = { storage: null, reload, now: () => 1_000_000 }
    expect(handleStaleAction(stale(), deps)).toBe('reloading')
    expect(handleStaleAction(stale(), deps)).toBe('reload-blocked')
  })
})

describe('staleActionMessage', () => {
  it('maps the outcome to the crew-facing copy', async () => {
    const { staleActionMessage, STALE_ACTION_MESSAGE } = await loadLib()
    const deps = { storage: memoryStorage(), reload: vi.fn(), now: () => 1_000_000 }
    expect(staleActionMessage(stale(), deps)).toBe(STALE_ACTION_MESSAGE.reloading)
    expect(staleActionMessage(stale(), deps)).toBe(STALE_ACTION_MESSAGE['reload-blocked'])
    expect(STALE_ACTION_MESSAGE.reloading).toBe('App updated — reloading…')
  })
})
