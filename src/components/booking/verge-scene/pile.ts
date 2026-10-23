import type { Database } from '@/lib/supabase/types'

/**
 * Pure layout for the verge-scene pile — no three.js, so it is unit-tested
 * and shared by the 3D canvas and the static SVG fallback.
 *
 * Keyed on `service.waste_stream`, not `category.code`: Bulk covers both
 * general and green waste, which residents must keep in separate piles.
 */
export type WasteStream = Database['public']['Enums']['waste_stream']

export type PieceShape =
  | 'box'
  | 'bag'
  | 'plank'
  | 'branch'
  | 'leaves'
  | 'appliance'
  | 'mattress'
  | 'screen'
  | 'tyre'

export interface PilePiece {
  shape: PieceShape
  /** Centre of the piece in metres, relative to the middle of the pile's footprint at ground level. */
  position: [number, number, number]
  /** Turn about the vertical axis, radians. */
  yaw: number
  /** Bounding width (x), height (y), depth (z) in metres. */
  size: [number, number, number]
  colour: string
}

/** Units beyond this still book normally — the pile just stops growing. */
export const PILE_MAX_UNITS = 6

/** Half-extents of the pile's footprint — the verge is shallower (z) than it is long (x). */
export const PILE_FOOTPRINT = { x: 1.2, z: 0.6 } as const

interface PieceTemplate {
  shape: PieceShape
  size: [number, number, number]
  colours: readonly string[]
}

interface StreamRecipe {
  /** Ancillary units are single items (a mattress, a fridge); the rest are loose loads. */
  piecesPerUnit: number
  templates: readonly PieceTemplate[]
  /** One seed per stream so a stream's pile always looks the same. */
  seed: number
}

const CARDBOARD = ['#B9895A', '#C99D6B', '#A97C4F'] as const
const BAG = ['#2F3437', '#3D4347'] as const
const TIMBER = ['#8B6A4A', '#9C7A57'] as const

const RECIPES: Record<WasteStream, StreamRecipe> = {
  general: {
    piecesPerUnit: 3,
    seed: 11,
    templates: [
      { shape: 'box', size: [0.5, 0.4, 0.45], colours: CARDBOARD },
      { shape: 'bag', size: [0.45, 0.4, 0.45], colours: BAG },
      { shape: 'plank', size: [1.1, 0.08, 0.18], colours: TIMBER },
      { shape: 'box', size: [0.45, 0.5, 0.45], colours: ['#7E8C99', '#9AA5AE'] },
    ],
  },
  green: {
    piecesPerUnit: 4,
    seed: 23,
    templates: [
      { shape: 'branch', size: [1.2, 0.1, 0.1], colours: ['#6B4F35', '#7A5A3C'] },
      { shape: 'leaves', size: [0.55, 0.45, 0.55], colours: ['#4E8A3E', '#3F7A35', '#6FA24F'] },
      { shape: 'leaves', size: [0.45, 0.35, 0.45], colours: ['#5C9446', '#4A8238'] },
    ],
  },
  ancillary: {
    piecesPerUnit: 1,
    seed: 37,
    templates: [
      { shape: 'mattress', size: [1.4, 0.2, 0.9], colours: ['#DCE6EE', '#E8E2D6'] },
      { shape: 'appliance', size: [0.6, 0.85, 0.6], colours: ['#F2F2EE', '#E6E8EA'] },
      { shape: 'screen', size: [0.75, 0.5, 0.12], colours: ['#23272B', '#33383D'] },
    ],
  },
  illegal_dumping: {
    piecesPerUnit: 3,
    seed: 53,
    templates: [
      { shape: 'tyre', size: [0.6, 0.2, 0.6], colours: ['#1E1E1E'] },
      { shape: 'bag', size: [0.45, 0.4, 0.45], colours: BAG },
      { shape: 'box', size: [0.5, 0.35, 0.45], colours: ['#8A7A66', '#7A6E60'] },
      { shape: 'plank', size: [1.0, 0.08, 0.18], colours: TIMBER },
    ],
  },
}

/** Mulberry32 — tiny seeded PRNG so the same props always draw the same pile. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Clamp a unit count to what the pile draws: whole, non-negative, capped. */
export function visibleUnits(size: number): number {
  if (!Number.isFinite(size) || size <= 0) return 0
  return Math.min(Math.floor(size), PILE_MAX_UNITS)
}

const CELL = 0.1
/** Spots tried per piece; it lands on the lowest, so a pile spreads before it stacks. */
const SETTLE_TRIES = 4

/**
 * Lay out the pile for `size` units of `stream`. Each piece is "dropped" onto
 * a coarse height map, so pieces settle into a mound. Piece i depends only on
 * pieces 0..i-1 and a fixed random sequence, so adding a unit appends pieces
 * and never reshuffles the ones already there.
 */
export function buildPile(stream: WasteStream, size: number): PilePiece[] {
  const recipe = RECIPES[stream]
  const count = visibleUnits(size) * recipe.piecesPerUnit
  const random = seededRandom(recipe.seed)
  const heights = new Map<string, number>()
  const pieces: PilePiece[] = []
  const fullPile = PILE_MAX_UNITS * recipe.piecesPerUnit

  for (let i = 0; i < count; i++) {
    // Every piece makes the same number of draws — keeps the sequence prefix-stable.
    const template = recipe.templates[Math.floor(random() * recipe.templates.length)]!
    const colour = template.colours[Math.floor(random() * template.colours.length)]!
    const yaw = random() * Math.PI

    const [w, h, d] = template.size
    // Axis-aligned extent of the turned piece on the ground.
    const cos = Math.abs(Math.cos(yaw))
    const sin = Math.abs(Math.sin(yaw))
    const ex = (cos * w + sin * d) / 2
    const ez = (sin * w + cos * d) / 2
    // Keep the whole piece inside the footprint, not just its centre. A small
    // load stays compact; the pile spreads to the full footprint as it grows.
    const spread = 0.5 + 0.5 * Math.sqrt(i / fullPile)
    const reachX = Math.max(0, PILE_FOOTPRINT.x - ex) * spread
    const reachZ = Math.max(0, PILE_FOOTPRINT.z - ez) * spread

    let spot = { x: 0, z: 0, base: Number.POSITIVE_INFINITY }
    for (let t = 0; t < SETTLE_TRIES; t++) {
      // Linear (not sqrt) radius leans towards the middle, so the mound peaks there.
      const radius = random()
      const angle = random() * Math.PI * 2
      const x = Math.cos(angle) * radius * reachX
      const z = Math.sin(angle) * radius * reachZ
      // Rest on the average height beneath, not the peak: pieces nestle into
      // the gaps of a jumbled pile instead of balancing on its highest point.
      const cells = cellsUnder(x, z, ex, ez)
      const base = cells.reduce((sum, key) => sum + (heights.get(key) ?? 0), 0) / cells.length
      if (base < spot.base) spot = { x, z, base }
    }

    for (const key of cellsUnder(spot.x, spot.z, ex, ez)) {
      heights.set(key, Math.max(heights.get(key) ?? 0, spot.base + h))
    }
    pieces.push({ shape: template.shape, position: [spot.x, spot.base + h / 2, spot.z], yaw, size: [w, h, d], colour })
  }

  return pieces
}

/** Height-map cells covered by a piece centred at (x, z) with ground half-extents (ex, ez). */
function cellsUnder(x: number, z: number, ex: number, ez: number): string[] {
  const keys: string[] = []
  for (let cx = Math.floor((x - ex) / CELL); cx <= Math.floor((x + ex) / CELL); cx++) {
    for (let cz = Math.floor((z - ez) / CELL); cz <= Math.floor((z + ez) / CELL); cz++) keys.push(`${cx},${cz}`)
  }
  return keys
}

/** Highest point of the pile in metres (0 when empty). */
export function pileHeight(pieces: readonly PilePiece[]): number {
  return pieces.reduce((top, p) => Math.max(top, p.position[1] + p.size[1] / 2), 0)
}

const STREAM_LABEL: Record<WasteStream, string> = {
  general: 'general waste',
  green: 'green waste',
  ancillary: 'ancillary items',
  illegal_dumping: 'dumped rubbish',
}

/** Accessible description of the scene — the canvas itself is decorative. */
export function describePile(stream: WasteStream, size: number): string {
  const units = Number.isFinite(size) && size > 0 ? Math.floor(size) : 0
  if (units === 0) return 'Illustration of a house with an empty verge.'
  return `Illustration of a house with ${STREAM_LABEL[stream]} on the verge, ${units} booked.`
}

/**
 * Which pile the scene shows for a cart: the stream with the most units
 * (ties go to the stream seen first). Lines without a stream are skipped.
 */
export function pickScenePile(
  lines: ReadonlyArray<{ stream: WasteStream | null | undefined; quantity: number }>,
): { stream: WasteStream; size: number } {
  const totals = new Map<WasteStream, number>()
  for (const { stream, quantity } of lines) {
    if (!stream || quantity <= 0) continue
    totals.set(stream, (totals.get(stream) ?? 0) + quantity)
  }
  let best: { stream: WasteStream; size: number } = { stream: 'general', size: 0 }
  for (const [stream, size] of totals) {
    if (size > best.size) best = { stream, size }
  }
  return best
}
