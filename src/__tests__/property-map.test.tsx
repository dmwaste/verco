import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { PropertyMap } from '@/components/booking/property-map'

// Mock Leaflet so we can assert the options the map is constructed with, and
// that it is torn down on unmount. The real Leaflet needs a sized DOM node and
// schedules real requestAnimationFrame callbacks — neither of which we want in
// a unit test.
const leaflet = vi.hoisted(() => {
  const remove = vi.fn()
  const mapInstance = { remove }
  const map = vi.fn<(el: unknown, opts: Record<string, unknown>) => typeof mapInstance>(
    () => mapInstance
  )
  const tileLayer = vi.fn(() => ({ addTo: vi.fn(() => ({})) }))
  const divIcon = vi.fn(() => ({}))
  const marker = vi.fn(() => ({ addTo: vi.fn(() => ({ bindPopup: vi.fn() })) }))
  return { remove, mapInstance, map, tileLayer, divIcon, marker }
})

vi.mock('leaflet', () => ({
  default: {
    map: leaflet.map,
    tileLayer: leaflet.tileLayer,
    divIcon: leaflet.divIcon,
    marker: leaflet.marker,
  },
}))
vi.mock('leaflet/dist/leaflet.css', () => ({}))

describe('PropertyMap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('disables inertia so a drag-momentum frame cannot fire on a removed map', () => {
    // Regression guard for JAVASCRIPT-NEXTJS-K: dragging the map and navigating
    // away before the inertia animation settled scheduled a requestAnimationFrame
    // that ran panBy() -> DomUtil.addClass(this._mapPane, …) AFTER map.remove()
    // had nulled _mapPane, throwing "undefined is not an object (t.classList)".
    // inertia:false removes the only code path that queues that deferred frame.
    render(<PropertyMap lat={-32.24} lng={115.75} address="23 Leda Blvd, Wellard" />)

    expect(leaflet.map).toHaveBeenCalledTimes(1)
    const options = leaflet.map.mock.calls[0]![1]
    expect(options.inertia).toBe(false)
  })

  it('tears the map down on unmount', () => {
    const { unmount } = render(
      <PropertyMap lat={-32.24} lng={115.75} address="23 Leda Blvd, Wellard" />
    )
    unmount()
    expect(leaflet.remove).toHaveBeenCalledTimes(1)
  })
})
