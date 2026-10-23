'use client'

import { Component, useSyncExternalStore, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import * as Sentry from '@sentry/nextjs'
import { cn } from '@/lib/utils'
import { describePile, type WasteStream } from './pile'
import { VergeSceneFallback } from './verge-scene-fallback'

// three.js + react-three-fiber stay out of the page bundle: the chunk is only
// fetched once we know this browser can draw the scene.
const VergeSceneCanvas = dynamic(
  () => import('./verge-scene-canvas').then((mod) => mod.VergeSceneCanvas),
  { ssr: false },
)

export interface VergeSceneProps {
  /** What the pile is made of. */
  stream: WasteStream
  /** Units booked; 0 shows an empty verge. Drawing stops growing at PILE_MAX_UNITS. */
  size: number
  className?: string
}

/**
 * Decorative 3D picture of a house with the booked pile on its verge.
 * Purely visual: every booking control lives outside it, so nothing here is
 * needed to book. Shows a static drawing while the 3D chunk loads, and keeps
 * it when WebGL2 is unavailable or the scene fails.
 */
export function VergeScene({ stream, size, className }: VergeSceneProps) {
  const webgl = useWebGL2()
  const reducedMotion = usePrefersReducedMotion()

  return (
    <div
      role="img"
      aria-label={describePile(stream, size)}
      className={cn('relative aspect-[16/9] max-h-60 w-full overflow-hidden rounded-xl shadow-sm', className)}
    >
      {/* The canvas is transparent until its first frame, so this shows until the 3D paints over it. */}
      <VergeSceneFallback stream={stream} size={size} className="absolute inset-0 size-full" />
      {webgl && (
        <SceneErrorBoundary>
          <div className="absolute inset-0">
            <VergeSceneCanvas stream={stream} size={size} reducedMotion={reducedMotion} />
          </div>
        </SceneErrorBoundary>
      )}
    </div>
  )
}

class SceneErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error) {
    // A failed chunk load or GPU context lands here. The static drawing
    // underneath stays, so this is a warning, not an outage.
    Sentry.captureException(error, { level: 'warning', tags: { surface: 'verge-scene' } })
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function subscribeReducedMotion(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(REDUCED_MOTION_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION_QUERY).matches
}

/** Live `prefers-reduced-motion` — follows the OS setting if it changes mid-visit. */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false)
}

let webgl2Available: boolean | undefined

// three.js has required WebGL2 since r163, so a WebGL1-only browser gets the drawing.
function detectWebGL2(): boolean {
  if (webgl2Available === undefined) {
    try {
      const gl = document.createElement('canvas').getContext('webgl2')
      webgl2Available = !!gl
      // Free the probe straight away — browsers cap the number of live contexts.
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    } catch {
      webgl2Available = false
    }
  }
  return webgl2Available
}

const noSubscription = () => () => {}

/** False on the server and during hydration, then the browser's answer (probed once). */
function useWebGL2(): boolean {
  return useSyncExternalStore(noSubscription, detectWebGL2, () => false)
}
