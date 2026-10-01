import type { Rng } from '../core/random'

export interface GearSpec {
  id: number
  teeth: number
  /** Pitch radius = module × teeth / 2. */
  radius: number
  x: number
  z: number
  /** Index of the gear driving this one, -1 for the driver. */
  parent: number
  depth: number
  /** +1 turns with the driver, -1 against it. */
  sign: number
  /** Speed ratio relative to the driver: driverTeeth / teeth. */
  ratio: number
  /** Rotation at driver angle 0, chosen so teeth interlock with the parent. */
  phase: number
}

export interface GearTrain {
  gears: GearSpec[]
  module: number
  /** Radius of the circle containing every gear. */
  bound: number
  maxDepth: number
}

/** Fraction of power surviving each gear mesh. */
export const MESH_EFFICIENCY = 0.97
const BASE_MODULE = 0.16
const WORLD_RADIUS = 9
const TAU = Math.PI * 2

/**
 * Grows a gear train as a tree from a single driver. Every gear shares one
 * module so any pair can mesh; a child sits exactly r1 + r2 from its parent.
 *
 * Angles use the convention of a rotation about +Y: angle a points along
 * (cos a, 0, -sin a).
 */
export function generateGearTrain(rng: Rng, count: number, sizeScale: number): GearTrain {
  const module = BASE_MODULE * sizeScale
  const driverTeeth = rng.int(12, 16)
  const gears: GearSpec[] = [
    {
      id: 0,
      teeth: driverTeeth,
      radius: (module * driverTeeth) / 2,
      x: 0,
      z: 0,
      parent: -1,
      depth: 0,
      sign: 1,
      ratio: 1,
      phase: 0,
    },
  ]

  let attempts = count * 80
  while (gears.length < count && attempts-- > 0) {
    const parent = rng.pick(gears)
    const teeth = rng.int(8, 22)
    const radius = (module * teeth) / 2
    const direction = rng.range(0, TAU)
    const distance = parent.radius + radius
    const x = parent.x + Math.cos(direction) * distance
    const z = parent.z - Math.sin(direction) * distance

    if (Math.hypot(x, z) + radius > WORLD_RADIUS) continue
    // Teeth extend one module past the pitch circle on both gears.
    const clearance = module * 2.6
    const collides = gears.some(
      (other) => other !== parent && Math.hypot(other.x - x, other.z - z) < other.radius + radius + clearance,
    )
    if (collides) continue

    // Mesh condition: a parent tooth at the contact point meets a child gap.
    // In tooth-pitch units the parent's position u and the child's v satisfy u + v = 1/2.
    const u = ((direction - parent.phase) * parent.teeth) / TAU
    const phase = direction + Math.PI - (TAU / teeth) * (0.5 - u)

    gears.push({
      id: gears.length,
      teeth,
      radius,
      x,
      z,
      parent: parent.id,
      depth: parent.depth + 1,
      sign: -parent.sign,
      ratio: driverTeeth / teeth,
      phase,
    })
  }

  let bound = 0
  let maxDepth = 0
  for (const gear of gears) {
    bound = Math.max(bound, Math.hypot(gear.x, gear.z) + gear.radius + module)
    maxDepth = Math.max(maxDepth, gear.depth)
  }
  return { gears, module, bound, maxDepth }
}

/** Rotation of a gear for a given driver rotation. */
export function gearAngle(gear: GearSpec, driverAngle: number): number {
  return gear.phase + gear.sign * gear.ratio * driverAngle
}

/** Angular velocity of a gear for a given driver angular velocity. */
export function gearOmega(gear: GearSpec, driverOmega: number): number {
  return gear.sign * gear.ratio * driverOmega
}

/** Torque delivered at a gear, after losses at each mesh on the way there. */
export function gearTorque(gear: GearSpec, driverTorque: number): number {
  return (driverTorque / gear.ratio) * MESH_EFFICIENCY ** gear.depth
}

export function systemEfficiency(train: GearTrain): number {
  return MESH_EFFICIENCY ** train.maxDepth
}
