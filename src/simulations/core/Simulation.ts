import type * as THREE from 'three'
import type { Emitter } from './Emitter'

export type Quality = 'preview' | 'full'
export type ParamValue = number | boolean | string
export type StatValue = number | string

/** Fixed simulation timestep in seconds. All simulation logic advances in these increments. */
export const STEP = 1 / 60

export interface SimulationEvent {
  type: string
  level?: 'info' | 'warn'
  title?: string
  message?: string
}

export interface SimulationContext {
  /** Shared renderer, owned by the Stage. Simulations never create their own. */
  renderer: THREE.WebGLRenderer
  quality: Quality
  seed: number
  mobile: boolean
  reducedMotion: boolean
  /** DOM element the simulation is drawn into. Used for pointer input. */
  element: HTMLElement | null
}

export interface Simulation {
  readonly scene: THREE.Scene
  readonly camera: THREE.Camera
  /** Point the host camera controls orbit around. */
  readonly focus: THREE.Vector3
  readonly events: Emitter<SimulationEvent>
  /** False while the simulation drives the camera itself (e.g. a follow cam). */
  hostCameraEnabled: boolean
  init(ctx: SimulationContext): Promise<void>
  /** Advance simulation logic by one fixed timestep. */
  step(dt: number): void
  /** Sync visuals to state. alpha is the interpolation factor between steps. */
  render(alpha: number): void
  setParam(key: string, value: ParamValue): void
  action(key: string): void
  getStats(): Record<string, StatValue>
  /** Number of live simulated entities, for the debug overlay. */
  entityCount(): number
  resize(width: number, height: number): void
  reset(seed?: number): void
  dispose(): void
}
