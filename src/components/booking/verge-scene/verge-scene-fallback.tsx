import { buildPile, type WasteStream } from './pile'

// Front-on drawing of the same house, verge and pile as the 3D scene.
// Pixels per metre, and where the pile's footprint centre lands.
const SCALE = 26
const PILE_X = 205
const GROUND_Y = 146
// Pieces further back sit a little higher, as in the 3D camera's view.
const DEPTH_LIFT = 0.35

interface VergeSceneFallbackProps {
  stream: WasteStream
  size: number
  className?: string
}

export function VergeSceneFallback({ stream, size, className }: VergeSceneFallbackProps) {
  // Back to front, so nearer pieces overlap the ones behind.
  const pieces = buildPile(stream, size).sort((a, b) => a.position[2] - b.position[2])

  return (
    <svg
      viewBox="0 0 320 180"
      preserveAspectRatio="xMidYMid slice"
      className={className}
      aria-hidden
      focusable="false"
    >
      <rect width="320" height="180" fill="#DCEBF5" />
      <rect y="106" width="320" height="30" fill="#A6CF84" />
      <rect y="134" width="320" height="2" fill="#F4F1EA" />
      <rect y="136" width="320" height="17" fill="#8FBF6A" />
      <rect y="153" width="320" height="3" fill="#C9CDD1" />
      <rect y="156" width="320" height="24" fill="#6B7178" />

      {/* House — roof takes the council's brand colour, like the 3D roof */}
      <rect x="62" y="64" width="104" height="44" fill="#EFE6D8" />
      <polygon points="54,64 114,32 174,64" fill="var(--brand, #293F52)" />
      <rect x="104" y="80" width="20" height="28" fill="#7A5638" />
      <rect x="74" y="76" width="22" height="16" fill="#BFD9EA" />
      <rect x="132" y="76" width="22" height="16" fill="#BFD9EA" />

      {/* Verge tree */}
      <rect x="27" y="118" width="5" height="28" fill="#6B4F35" />
      <circle cx="29.5" cy="108" r="17" fill="#4E8A3E" />

      <ellipse cx={PILE_X} cy={GROUND_Y} rx={SCALE * 1.1} ry="4" fill="#7FAE5C" />
      {pieces.map((piece, i) => {
        const [x, y, z] = piece.position
        const [w, h, d] = piece.size
        // Width as seen from the front once the piece is turned.
        const across = (Math.abs(Math.cos(piece.yaw)) * w + Math.abs(Math.sin(piece.yaw)) * d) * SCALE
        const cx = PILE_X + x * SCALE
        const cy = GROUND_Y - (y - z * DEPTH_LIFT) * SCALE
        const tall = h * SCALE
        const round = piece.shape === 'bag' || piece.shape === 'leaves' || piece.shape === 'tyre'
        return round ? (
          <ellipse key={i} cx={cx} cy={cy} rx={across / 2} ry={tall / 2} fill={piece.colour} />
        ) : (
          <rect key={i} x={cx - across / 2} y={cy - tall / 2} width={across} height={tall} rx="1.5" fill={piece.colour} />
        )
      })}
    </svg>
  )
}
