import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

/**
 * The scene wrapper decides what a resident sees: the static drawing (no
 * WebGL2, or the 3D failed) or the lazily-loaded canvas, with motion off when
 * the OS asks for reduced motion. The canvas itself is stubbed — jsdom has no
 * WebGL — so these tests pin the decisions, not the three.js drawing.
 */

const captureException = vi.hoisted(() => vi.fn())
vi.mock('@sentry/nextjs', () => ({ captureException }))

const canvasProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }))
const canvasLoaded = vi.hoisted(() => vi.fn())
const canvasShouldThrow = vi.hoisted(() => ({ current: false }))
vi.mock('@/components/booking/verge-scene/verge-scene-canvas', () => {
  canvasLoaded()
  return {
    VergeSceneCanvas: (props: Record<string, unknown>) => {
      if (canvasShouldThrow.current) throw new Error('context lost')
      canvasProps.current = props
      return <canvas data-testid="verge-canvas" />
    },
  }
})

function stubWebGL2(available: boolean) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
    available && type === 'webgl2' ? { getExtension: () => ({ loseContext: () => {} }) } : null) as never)
}

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: reduce && query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}

// The WebGL2 probe is cached per page load, so each test gets a fresh module.
async function loadScene() {
  vi.resetModules()
  return (await import('@/components/booking/verge-scene/verge-scene')).VergeScene
}

beforeEach(() => {
  canvasProps.current = null
  canvasShouldThrow.current = false
  canvasLoaded.mockClear()
  captureException.mockClear()
  stubReducedMotion(false)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('VergeScene', () => {
  it('describes the pile once, on the wrapper, for screen readers', async () => {
    stubWebGL2(false)
    const VergeScene = await loadScene()
    render(<VergeScene stream="green" size={2} />)
    expect(
      screen.getByRole('img', { name: 'Illustration of a house with green waste on the verge, 2 booked.' }),
    ).toBeInTheDocument()
  })

  it('keeps the static drawing and never downloads the 3D chunk without WebGL2', async () => {
    stubWebGL2(false)
    const VergeScene = await loadScene()
    const { container } = render(<VergeScene stream="general" size={3} />)
    expect(container.querySelector('svg')).toBeInTheDocument()
    // Give a lazy import every chance to start before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByTestId('verge-canvas')).not.toBeInTheDocument()
    expect(canvasLoaded).not.toHaveBeenCalled()
  })

  it('loads the canvas over the drawing when WebGL2 is available', async () => {
    stubWebGL2(true)
    const VergeScene = await loadScene()
    const { container } = render(<VergeScene stream="ancillary" size={1} />)
    expect(await screen.findByTestId('verge-canvas')).toBeInTheDocument()
    // The drawing stays underneath — it is what shows until the first 3D frame.
    expect(container.querySelector('svg')).toBeInTheDocument()
    expect(canvasProps.current).toMatchObject({ stream: 'ancillary', size: 1, reducedMotion: false })
  })

  it('passes the OS reduced-motion preference to the canvas', async () => {
    stubWebGL2(true)
    stubReducedMotion(true)
    const VergeScene = await loadScene()
    render(<VergeScene stream="general" size={1} />)
    await screen.findByTestId('verge-canvas')
    expect(canvasProps.current).toMatchObject({ reducedMotion: true })
  })

  it('falls back to the drawing and warns Sentry when the 3D scene throws', async () => {
    stubWebGL2(true)
    canvasShouldThrow.current = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const VergeScene = await loadScene()
    const { container } = render(<VergeScene stream="general" size={2} />)
    await vi.waitFor(() => expect(captureException).toHaveBeenCalled())
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ level: 'warning' }))
    expect(screen.queryByTestId('verge-canvas')).not.toBeInTheDocument()
    expect(container.querySelector('svg')).toBeInTheDocument()
    expect(screen.getByRole('img')).toBeInTheDocument()
  })

  it('draws more of the pile in the fallback as units are added', async () => {
    stubWebGL2(false)
    const VergeScene = await loadScene()
    const shapes = (size: number) => {
      const { container, unmount } = render(<VergeScene stream="general" size={size} />)
      const count = container.querySelectorAll('svg rect, svg ellipse').length
      unmount()
      return count
    }
    expect(shapes(3)).toBeGreaterThan(shapes(1))
  })
})
