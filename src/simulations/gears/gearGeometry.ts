import * as THREE from 'three'

/**
 * Procedural spur gear lying in the XZ plane, bottom face at y = 0.
 * A tooth is centered on local angle 0, matching GearGenerator's phase math.
 */
export function createGearGeometry(teeth: number, module: number, thickness: number): THREE.BufferGeometry {
  const pitchRadius = (module * teeth) / 2
  const rootRadius = pitchRadius - module * 1.25
  const outerRadius = pitchRadius + module
  const pitch = (Math.PI * 2) / teeth

  const shape = new THREE.Shape()
  for (let k = 0; k < teeth; k++) {
    const center = k * pitch
    // Trapezoidal tooth: wide at the root, narrow at the tip.
    const corners: [number, number][] = [
      [rootRadius, center - pitch * 0.31],
      [outerRadius, center - pitch * 0.13],
      [outerRadius, center + pitch * 0.13],
      [rootRadius, center + pitch * 0.31],
    ]
    for (const [radius, angle] of corners) {
      const x = Math.cos(angle) * radius
      const y = Math.sin(angle) * radius
      if (k === 0 && radius === rootRadius && angle < center) shape.moveTo(x, y)
      else shape.lineTo(x, y)
    }
  }
  shape.closePath()

  const boreRadius = Math.max(module * 1.1, 0.1)
  const bore = new THREE.Path()
  bore.absarc(0, 0, boreRadius, 0, Math.PI * 2, true)
  shape.holes.push(bore)

  // Lightening holes make rotation readable on the larger gears.
  if (teeth >= 13) {
    const holes = teeth >= 18 ? 6 : 5
    const ringRadius = (rootRadius + boreRadius) / 2 + module * 0.2
    const holeRadius = (rootRadius - boreRadius) * 0.24
    for (let i = 0; i < holes; i++) {
      const angle = (i / holes) * Math.PI * 2 + pitch / 2
      const hole = new THREE.Path()
      hole.absarc(Math.cos(angle) * ringRadius, Math.sin(angle) * ringRadius, holeRadius, 0, Math.PI * 2, true)
      shape.holes.push(hole)
    }
  }

  const bevel = module * 0.12
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: thickness - bevel * 2,
    bevelEnabled: true,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 1,
    curveSegments: 10,
  })
  geometry.translate(0, 0, bevel)
  geometry.rotateX(-Math.PI / 2)
  return geometry
}
