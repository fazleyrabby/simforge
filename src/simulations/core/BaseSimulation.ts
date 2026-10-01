import * as THREE from 'three'
import { fitOrtho } from '../../three/cameras'
import { disposeObject } from '../../three/dispose'
import { getEnvironment } from '../../three/environment'
import { addLabLighting, type LabLighting } from '../../three/lights'
import { palette } from '../../three/palette'
import { Emitter } from './Emitter'
import { Rng } from './random'
import type { ParamValue, Simulation, SimulationContext, SimulationEvent, StatValue } from './Simulation'

/**
 * Shared lifecycle for every simulation: seeded RNG, lighting, camera fitting,
 * rebuild-on-reset and disposal. Subclasses implement build / update / render.
 */
export abstract class BaseSimulation implements Simulation {
  readonly scene = new THREE.Scene()
  readonly focus = new THREE.Vector3()
  readonly events = new Emitter<SimulationEvent>()
  hostCameraEnabled = true

  protected ctx!: SimulationContext
  protected rng = new Rng(1)
  protected seed = 1
  protected time = 0
  protected width = 1
  protected height = 1
  /** Everything built from the seed lives here and is torn down on reset. */
  protected world = new THREE.Group()
  protected lighting!: LabLighting
  /** Screen-space half extents the orthographic camera must keep visible. */
  protected viewHalfWidth = 10
  protected viewHalfHeight = 10
  protected params: Record<string, ParamValue> = {}
  private ready = false

  constructor(readonly camera: THREE.OrthographicCamera | THREE.PerspectiveCamera) {}

  async init(ctx: SimulationContext): Promise<void> {
    this.ctx = ctx
    this.seed = ctx.seed
    this.rng = new Rng(this.seed)
    this.scene.background = new THREE.Color(palette.background)
    this.scene.environment = getEnvironment(ctx.renderer)
    this.scene.environmentIntensity = 0.4
    this.lighting = addLabLighting(this.scene, ctx)
    this.scene.add(this.world)
    this.build()
    this.ready = true
  }

  step(dt: number): void {
    this.time += dt
    this.update(dt)
  }

  setParam(key: string, value: ParamValue): void {
    if (this.params[key] === value) return
    this.params[key] = value
    if (this.ready) this.onParam(key, value)
  }

  action(_key: string): void {}

  resize(width: number, height: number): void {
    this.width = width
    this.height = height
    this.fitCamera()
  }

  reset(seed?: number): void {
    if (seed !== undefined) this.seed = seed
    this.rebuild()
  }

  dispose(): void {
    this.ready = false
    this.teardown()
    // The environment map is shared across simulations and outlives this scene.
    this.scene.environment = null
    disposeObject(this.scene)
    this.scene.clear()
    this.events.clear()
  }

  entityCount(): number {
    return 0
  }

  abstract render(alpha: number): void
  abstract getStats(): Record<string, StatValue>

  /** Construct the world from this.rng and this.params. */
  protected abstract build(): void
  protected abstract update(dt: number): void
  /** React to a parameter change after init. */
  protected onParam(_key: string, _value: ParamValue): void {}
  /** Release anything build() created outside this.world (listeners, caches). */
  protected teardown(): void {}

  /** Tear the world down and build it again from the current seed. */
  protected rebuild(): void {
    this.teardown()
    disposeObject(this.world)
    this.world.clear()
    this.rng = new Rng(this.seed)
    this.time = 0
    this.build()
  }

  protected setView(halfWidth: number, halfHeight: number): void {
    this.viewHalfWidth = halfWidth
    this.viewHalfHeight = halfHeight
    this.fitCamera()
  }

  protected num(key: string): number {
    return Number(this.params[key])
  }

  protected bool(key: string): boolean {
    return Boolean(this.params[key])
  }

  protected get isPreview(): boolean {
    return this.ctx.quality === 'preview'
  }

  /** Marks meshes under an object as shadow casters/receivers (no-op cost in previews). */
  protected enableShadows(root: THREE.Object3D, receive = true): void {
    if (this.isPreview || this.ctx.mobile) return
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true
        object.receiveShadow = receive
      }
    })
  }

  private fitCamera(): void {
    if (this.camera instanceof THREE.OrthographicCamera) {
      fitOrtho(this.camera, this.width, this.height, this.viewHalfWidth, this.viewHalfHeight)
    } else {
      this.camera.aspect = this.width / Math.max(this.height, 1)
      this.camera.updateProjectionMatrix()
    }
  }
}
