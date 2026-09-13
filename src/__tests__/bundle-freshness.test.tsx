import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'

let pathname = '/field/run-sheet'
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}))

const checkBundleFreshness = vi.fn(async () => false)
vi.mock('@/lib/bundle/reload-if-stale', () => ({
  // Arrow defers the reference until call time — vi.mock factories run
  // during the hoisted import, before the const above is initialised.
  checkBundleFreshness: () => checkBundleFreshness(),
}))

import { BundleFreshness } from '@/components/bundle-freshness'

/**
 * ADR 0023 — the field + admin layouts mount this once; every soft navigation
 * re-runs the (lib-throttled) /api/health SHA check so a stale bundle reloads
 * at a moment where nothing has been typed yet.
 */
describe('BundleFreshness', () => {
  beforeEach(() => {
    checkBundleFreshness.mockClear()
    pathname = '/field/run-sheet'
  })

  it('renders nothing and checks on mount', () => {
    const { container } = render(<BundleFreshness />)
    expect(container).toBeEmptyDOMElement()
    expect(checkBundleFreshness).toHaveBeenCalledTimes(1)
  })

  it('checks again on each navigation, not on unrelated re-renders', () => {
    const { rerender } = render(<BundleFreshness />)
    expect(checkBundleFreshness).toHaveBeenCalledTimes(1)

    rerender(<BundleFreshness />) // same pathname
    expect(checkBundleFreshness).toHaveBeenCalledTimes(1)

    pathname = '/field/stops/stop-1'
    rerender(<BundleFreshness />)
    expect(checkBundleFreshness).toHaveBeenCalledTimes(2)
  })
})
