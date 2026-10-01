import * as THREE from 'three'

function disposeMaterial(material: THREE.Material): void {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) value.dispose()
  }
  if (material instanceof THREE.ShaderMaterial) {
    for (const uniform of Object.values(material.uniforms)) {
      if (uniform.value instanceof THREE.Texture) uniform.value.dispose()
    }
  }
  material.dispose()
}

/** Releases every geometry, material and texture under an object. Safe to call twice. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    if (mesh.material) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) disposeMaterial(material)
    }
    if (object instanceof THREE.InstancedMesh) object.dispose()
    if (object instanceof THREE.DirectionalLight) object.shadow.map?.dispose()
  })
}
