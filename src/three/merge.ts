import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * Collapses the plain meshes directly under `parent` into one mesh per
 * material, baking each mesh's transform into the merged geometry.
 *
 * Only direct children are touched, so anything animated should live in its
 * own Group. Instanced meshes, hidden picking targets and anything `keep`
 * returns true for are left alone.
 */
export function mergeStaticMeshes(parent: THREE.Object3D, keep?: (mesh: THREE.Mesh) => boolean): void {
  const groups = new Map<THREE.Material, THREE.Mesh[]>()
  for (const child of parent.children) {
    if (!(child instanceof THREE.Mesh) || child instanceof THREE.InstancedMesh) continue
    if (Array.isArray(child.material) || !child.material.visible || child.children.length > 0) continue
    if (keep?.(child)) continue
    const list = groups.get(child.material) ?? []
    list.push(child)
    groups.set(child.material, list)
  }

  const retired = new Set<THREE.BufferGeometry>()
  for (const [material, meshes] of groups) {
    if (meshes.length < 2) continue
    const baked = meshes.map((mesh) => {
      mesh.updateMatrix()
      return mesh.geometry.clone().applyMatrix4(mesh.matrix)
    })
    const merged = mergeGeometries(baked)
    for (const geometry of baked) geometry.dispose()
    // Mixed attribute layouts cannot be merged; leave those meshes as they were.
    if (!merged) continue
    for (const mesh of meshes) {
      retired.add(mesh.geometry)
      parent.remove(mesh)
    }
    parent.add(new THREE.Mesh(merged, material))
  }
  // Shared geometries are released once, after every mesh using them is gone.
  for (const geometry of retired) geometry.dispose()
}
