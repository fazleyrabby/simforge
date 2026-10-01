import * as THREE from 'three'
import type { SimulationContext } from '../simulations/core/Simulation'

export interface LabLighting {
  key: THREE.DirectionalLight
  setShadowExtent(extent: number): void
}

/** The lighting rig shared by every simulation: soft sky fill, warm key, cool rim. */
export function addLabLighting(scene: THREE.Scene, ctx: SimulationContext): LabLighting {
  const hemisphere = new THREE.HemisphereLight(0xc4d6ff, 0x1c1610, 0.85)
  scene.add(hemisphere)

  const key = new THREE.DirectionalLight(0xfff1dc, 2.4)
  key.position.set(14, 26, 10)
  scene.add(key)
  scene.add(key.target)

  const rim = new THREE.DirectionalLight(0x7fb4ff, 0.7)
  rim.position.set(-12, 9, -14)
  scene.add(rim)

  // Previews skip shadows entirely; they share one GPU with every other card.
  if (ctx.quality === 'full') {
    key.castShadow = true
    const size = ctx.mobile ? 1024 : 2048
    key.shadow.mapSize.set(size, size)
    key.shadow.bias = -0.0004
    key.shadow.normalBias = 0.03
    key.shadow.radius = 4
  }

  return {
    key,
    setShadowExtent(extent: number) {
      const camera = key.shadow.camera
      camera.left = -extent
      camera.right = extent
      camera.top = extent
      camera.bottom = -extent
      camera.near = 1
      camera.far = 90
      camera.updateProjectionMatrix()
    },
  }
}
