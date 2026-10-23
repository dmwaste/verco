'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, RoundedBox } from '@react-three/drei'
import type { Group } from 'three'
import { buildPile, PILE_FOOTPRINT, type PilePiece, type WasteStream } from './pile'

// World is metres: +x along the street, +z from the house towards the road.
const VERGE_Z = 1.45
const PILE_ORIGIN: [number, number, number] = [0.9, 0, VERGE_Z]
const HOUSE_ORIGIN: [number, number, number] = [-1.4, 0, -2.6]
// A wide-ish lens from close in: the pile (near) reads big, the house (far) stays context.
const CAMERA_POSITION: [number, number, number] = [3.2, 2.6, 6.4]
const CAMERA_FOV = 40
const LOOK_AT: [number, number, number] = [0, 1.0, 0]

const SKY = '#DCEBF5'
const WALL = '#EFE6D8'
const DEFAULT_ROOF = '#293F52'

// New pieces drop in from above, then settle — skipped under reduced motion.
const DROP_HEIGHT = 1.2
const DROP_SECONDS = 0.35
// On-demand frames are sparse; the first frame after idle can carry a delta of
// several seconds, which would finish the drop before it is ever seen.
const MAX_FRAME_DELTA = 1 / 30

export interface VergeSceneCanvasProps {
  stream: WasteStream
  size: number
  reducedMotion: boolean
}

export function VergeSceneCanvas({ stream, size, reducedMotion }: VergeSceneCanvasProps) {
  return (
    <Canvas
      // Renders only when something changes — no GPU work while the scene sits idle.
      frameloop="demand"
      // PCF by name: R3F's default asks for PCFSoftShadowMap, which three r18x removed (it warns, then uses this).
      shadows="percentage"
      dpr={[1, 2]}
      camera={{ position: CAMERA_POSITION, fov: CAMERA_FOV }}
      gl={{ antialias: true, powerPreference: 'low-power' }}
      aria-hidden
    >
      <color attach="background" args={[SKY]} />
      <hemisphereLight args={['#FFFFFF', '#8FBF6A', 1.6]} />
      <directionalLight
        position={[5, 8, 5]}
        intensity={2.2}
        castShadow
        shadow-mapSize={[1024, 1024]}
      >
        {/* Built with args so the projection is computed — setting shadow-camera-left
            etc. as props would leave the default ±5 m frustum in place. */}
        <orthographicCamera attach="shadow-camera" args={[-7, 7, 7, -7, 0.5, 25]} />
      </directionalLight>
      <Ground />
      <House />
      <Tree />
      <Pile stream={stream} size={size} reducedMotion={reducedMotion} />
      <Controls reducedMotion={reducedMotion} />
    </Canvas>
  )
}

function Controls({ reducedMotion }: { reducedMotion: boolean }) {
  const get = useThree((s) => s.get)
  // Pinned to the canvas: left to default, the controls connect to the canvas
  // and then reconnect to R3F's event root once it registers, re-applying
  // touch-action: none there after the override below has already run.
  const canvas = useThree((s) => s.gl.domElement)

  // three-stdlib sets touch-action: none when OrbitControls connects (in the
  // child's effect, which runs before this one). That would trap a phone
  // user's page scroll on the scene; pan-y hands vertical swipes back to the
  // page while a sideways drag still turns the scene.
  useEffect(() => {
    get().gl.domElement.style.touchAction = 'pan-y'
  }, [get])

  return (
    <OrbitControls
      domElement={canvas}
      target={LOOK_AT}
      enableZoom={false}
      enablePan={false}
      // Gliding on after release is motion the user didn't ask for.
      enableDamping={!reducedMotion}
      rotateSpeed={0.6}
      minAzimuthAngle={-0.2}
      maxAzimuthAngle={1.0}
      minPolarAngle={1.05}
      maxPolarAngle={1.45}
    />
  )
}

function Ground() {
  return (
    <group>
      {/* Front yard */}
      <mesh position={[0, -0.03, -1.95]} receiveShadow>
        <boxGeometry args={[16, 0.06, 5.1]} />
        <meshStandardMaterial color="#A6CF84" />
      </mesh>
      {/* Path to the front door */}
      <mesh position={[HOUSE_ORIGIN[0], 0.005, -0.4]} receiveShadow>
        <boxGeometry args={[0.9, 0.02, 2]} />
        <meshStandardMaterial color="#D8CFC0" />
      </mesh>
      {/* Low fence on the property line, gap at the path */}
      <mesh position={[-5.3, 0.15, 0.6]} castShadow receiveShadow>
        <boxGeometry args={[7, 0.3, 0.06]} />
        <meshStandardMaterial color="#F4F1EA" />
      </mesh>
      <mesh position={[3.6, 0.15, 0.6]} castShadow receiveShadow>
        <boxGeometry args={[8.8, 0.3, 0.06]} />
        <meshStandardMaterial color="#F4F1EA" />
      </mesh>
      {/* Verge */}
      <mesh position={[0, -0.03, VERGE_Z]} receiveShadow>
        <boxGeometry args={[16, 0.06, 1.7]} />
        <meshStandardMaterial color="#8FBF6A" />
      </mesh>
      {/* Kerb */}
      <mesh position={[0, 0.04, 2.35]} receiveShadow>
        <boxGeometry args={[16, 0.14, 0.15]} />
        <meshStandardMaterial color="#C9CDD1" />
      </mesh>
      {/* Road */}
      <mesh position={[0, -0.03, 4]} receiveShadow>
        <boxGeometry args={[16, 0.06, 3.2]} />
        <meshStandardMaterial color="#6B7178" />
      </mesh>
    </group>
  )
}

function House() {
  const canvas = useThree((s) => s.gl.domElement)
  // Roof takes the council's brand colour so the scene matches its portal.
  const roof = useMemo(
    () => getComputedStyle(canvas).getPropertyValue('--brand').trim() || DEFAULT_ROOF,
    [canvas],
  )

  return (
    <group position={HOUSE_ORIGIN}>
      <RoundedBox args={[4, 2.1, 3]} radius={0.05} position={[0, 1.05, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={WALL} />
      </RoundedBox>
      {/* Hip roof: a 4-sided cone turned square-on, then squashed to the house's depth */}
      <group position={[0, 2.75, 0]} scale={[1, 1, 0.78]}>
        <mesh rotation-y={Math.PI / 4} castShadow>
          <coneGeometry args={[3.05, 1.3, 4]} />
          <meshStandardMaterial color={roof} flatShading />
        </mesh>
      </group>
      <mesh position={[0, 0.68, 1.53]}>
        <boxGeometry args={[0.75, 1.35, 0.06]} />
        <meshStandardMaterial color="#7A5638" />
      </mesh>
      {[-1.25, 1.25].map((x) => (
        <mesh key={x} position={[x, 1.25, 1.53]}>
          <boxGeometry args={[0.9, 0.7, 0.05]} />
          <meshStandardMaterial color="#BFD9EA" />
        </mesh>
      ))}
    </group>
  )
}

function Tree() {
  return (
    <group position={[-3.8, 0, VERGE_Z]}>
      <mesh position={[0, 0.7, 0]} castShadow>
        <cylinderGeometry args={[0.1, 0.14, 1.4, 6]} />
        <meshStandardMaterial color="#6B4F35" />
      </mesh>
      <mesh position={[0, 1.9, 0]} castShadow>
        <icosahedronGeometry args={[0.85, 0]} />
        <meshStandardMaterial color="#4E8A3E" flatShading />
      </mesh>
    </group>
  )
}

function Pile({ stream, size, reducedMotion }: VergeSceneCanvasProps) {
  const pieces = useMemo(() => buildPile(stream, size), [stream, size])

  return (
    <group position={PILE_ORIGIN}>
      {/* Faint patch of flattened grass marks where the pile goes, even when empty */}
      <mesh position={[0, 0.002, 0]} rotation-x={-Math.PI / 2} scale={[PILE_FOOTPRINT.x, PILE_FOOTPRINT.z, 1]} receiveShadow>
        <circleGeometry args={[1.1, 24]} />
        <meshStandardMaterial color="#7FAE5C" />
      </mesh>
      {/* Keyed by stream + index: a bigger pile keeps its pieces and only drops in the new ones */}
      {pieces.map((piece, i) => (
        <DroppingPiece key={`${stream}-${i}`} piece={piece} animate={!reducedMotion} />
      ))}
    </group>
  )
}

function DroppingPiece({ piece, animate }: { piece: PilePiece; animate: boolean }) {
  const ref = useRef<Group>(null)
  const [x, y, z] = piece.position
  // Fixed at mount so a later re-render never lifts a settled piece again.
  const [start] = useState<[number, number, number]>(() => [x, animate ? y + DROP_HEIGHT : y, z])
  const progress = useRef(animate ? 0 : 1)

  useFrame((state, delta) => {
    const group = ref.current
    if (!group || progress.current >= 1) return
    progress.current = Math.min(1, progress.current + Math.min(delta, MAX_FRAME_DELTA) / DROP_SECONDS)
    const eased = 1 - (1 - progress.current) ** 3
    group.position.y = y + (1 - eased) * DROP_HEIGHT
    // Keep asking for frames only while the drop is under way.
    state.invalidate()
  })

  return (
    <group ref={ref} position={start} rotation-y={piece.yaw}>
      <PieceMesh piece={piece} />
    </group>
  )
}

function PieceMesh({ piece }: { piece: PilePiece }) {
  const [w, h, d] = piece.size
  const material = <meshStandardMaterial color={piece.colour} flatShading roughness={0.85} />

  switch (piece.shape) {
    case 'bag':
    case 'leaves':
      return (
        <mesh scale={[w / 2, h / 2, d / 2]} castShadow receiveShadow>
          <icosahedronGeometry args={[1, piece.shape === 'bag' ? 1 : 0]} />
          {material}
        </mesh>
      )
    case 'branch':
      return (
        <mesh rotation-z={Math.PI / 2} castShadow receiveShadow>
          <cylinderGeometry args={[h / 2, h / 3, w, 6]} />
          {material}
        </mesh>
      )
    case 'tyre':
      return (
        <mesh rotation-x={Math.PI / 2} castShadow receiveShadow>
          <torusGeometry args={[(w - h) / 2, h / 2, 8, 18]} />
          {material}
        </mesh>
      )
    default:
      return (
        <RoundedBox args={[w, h, d]} radius={Math.min(w, h, d) * 0.2} smoothness={2} castShadow receiveShadow>
          {material}
        </RoundedBox>
      )
  }
}
