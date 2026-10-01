import * as THREE from 'three'

/** Orthographic diorama camera looking at the origin from the given direction. */
export function makeIsoCamera(direction: THREE.Vector3, distance = 80): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400)
  camera.position.copy(direction).normalize().multiplyScalar(distance)
  camera.lookAt(0, 0, 0)
  return camera
}

/**
 * Fits an orthographic frustum so a world needing `halfWidth` × `halfHeight`
 * of screen space stays fully visible at any aspect ratio.
 */
export function fitOrtho(
  camera: THREE.OrthographicCamera,
  width: number,
  height: number,
  halfWidth: number,
  halfHeight: number,
): void {
  const aspect = width / Math.max(height, 1)
  const fittedHeight = Math.max(halfHeight, halfWidth / aspect)
  camera.left = -fittedHeight * aspect
  camera.right = fittedHeight * aspect
  camera.top = fittedHeight
  camera.bottom = -fittedHeight
  camera.updateProjectionMatrix()
}
