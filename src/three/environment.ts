import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

const cache = new WeakMap<THREE.WebGLRenderer, THREE.Texture>()

/**
 * Soft studio reflections shared by every simulation. Generated once per
 * renderer and never disposed with a scene, so metals and paint have
 * something to reflect without each world paying for its own map.
 */
export function getEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  let texture = cache.get(renderer)
  if (!texture) {
    const generator = new THREE.PMREMGenerator(renderer)
    const room = new RoomEnvironment()
    texture = generator.fromScene(room, 0.04).texture
    room.dispose()
    generator.dispose()
    cache.set(renderer, texture)
  }
  return texture
}
