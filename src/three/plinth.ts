import * as THREE from 'three'
import { palette } from './palette'

/**
 * The base slab every miniature world sits on. Its top surface is at y = 0.
 */
export function makePlinth(width: number, depth: number): THREE.Group {
  const group = new THREE.Group()
  const height = 0.8

  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    new THREE.MeshStandardMaterial({ color: palette.plinth, roughness: 0.92, metalness: 0.05 }),
  )
  slab.position.y = -height / 2
  slab.receiveShadow = true
  group.add(slab)

  const edge = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(width, height, depth)),
    new THREE.LineBasicMaterial({ color: palette.plinthEdge }),
  )
  edge.position.y = -height / 2
  group.add(edge)

  return group
}
