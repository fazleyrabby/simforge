import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { makePlinth } from '../../three/plinth'
import { BaseSimulation } from '../core/BaseSimulation'
import { Rng } from '../core/random'
import type { ParamValue, SimulationContext, StatValue } from '../core/Simulation'
import { HydraulicPressModel } from './HydraulicPressModel'
import { DebrisSystem, PressFX } from './PressFX'
import {
  PRESS_OBJECT_DEFS,
  PressLogic,
} from './PressLogic'
import {
  applyCompression,
  buildGlassCube,
  buildNokiaFromModel,
  buildProceduralNokia,
  buildRubberBall,
  buildSodaCan,
  buildTungstenCube,
  shatterObject,
  type BuiltObject,
} from './PressObjects'

const CAMS = {
  wide: { pos: [40, 36, 92], target: [0, 26, 0] },
  close: { pos: [14, 19, 46], target: [0, 15, 0] },
  chaos: { pos: [52, 42, 112], target: [0, 22, 0] },
}

export default class PressSimulation extends BaseSimulation {
  private logic!: PressLogic
  private pressModel!: HydraulicPressModel
  private builtObject!: BuiltObject
  private debris!: DebrisSystem
  private fx!: PressFX

  private camTarget = new THREE.Vector3(0, 26, 0)
  private camPos = new THREE.Vector3(40, 36, 92)
  private camPreset: 'wide' | 'close' | 'chaos' = 'wide'
  private shake = 0
  private shakeHold = 0
  private lastShakeOffset = new THREE.Vector3()

  private slowMoFactor = 1
  private slowMoUntil = 0
  private previewTimer = 0

  private flashMesh!: THREE.Mesh
  private flashIntensity = 0

  private gltfModelScene: THREE.Group | null = null

  declare camera: THREE.PerspectiveCamera

  constructor() {
    const camera = new THREE.PerspectiveCamera(35, 1, 1, 1500)
    camera.position.set(40, 36, 92)
    camera.lookAt(0, 26, 0)
    super(camera)
    this.focus.set(0, 24, 0)
    this.params = {
      object: 'nokia3310',
      capacity: 100,
      timeScale: 1,
      cameraMode: 'auto',
    }
  }

  override async init(ctx: SimulationContext): Promise<void> {
    if (ctx.quality === 'full') {
      try {
        const loader = new GLTFLoader()
        const gltf = await loader.loadAsync('/models/nokia3310/nokia_3310.glb')
        this.gltfModelScene = gltf.scene
        this.gltfModelScene.traverse((o) => {
          if (o instanceof THREE.Mesh && o.material) {
            const mat = o.material as THREE.MeshStandardMaterial
            if (mat.name === 'Base') mat.roughness = 0.5
            if (mat.name === 'Trim') {
              mat.metalness = 0.75
              mat.roughness = 0.3
            }
            if (mat.name === 'Buttons') mat.roughness = 0.45
          }
        })
      } catch (err) {
        console.warn('GLTF Nokia 3310 model not loaded, using procedural fallback.', err)
      }
    }
    await super.init(ctx)

    this.lighting.key.position.set(40, 90, 60)
    this.lighting.setShadowExtent(60)
    this.lighting.key.shadow.camera.near = 10
    this.lighting.key.shadow.camera.far = 250
    this.updateParticleScale()
  }

  protected build(): void {
    const objectKey = (this.params.object as string) || (this.isPreview ? 'sodaCan' : 'nokia3310')
    const capacity = Number(this.params.capacity) || 100
    const def = PRESS_OBJECT_DEFS[objectKey] || PRESS_OBJECT_DEFS.nokia3310

    this.fx = new PressFX(this.scene, this.isPreview, this.seed + 11)
    this.debris = new DebrisSystem(this.scene)

    const groundFunc = (x: number, z: number) => (Math.abs(x) < 22 && Math.abs(z) < 14 ? 4 : 0)
    this.fx.groundAt = groundFunc
    this.debris.groundAt = groundFunc

    // Plinth at y = 0
    const plinth = makePlinth(90, 70)
    this.world.add(plinth)
    this.enableShadows(plinth, true)

    // Flash ring / plane
    const flashGeo = new THREE.PlaneGeometry(120, 100)
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
    this.flashMesh = new THREE.Mesh(flashGeo, flashMat)
    this.flashMesh.rotation.x = -Math.PI / 2
    this.flashMesh.position.y = 0.05
    this.world.add(this.flashMesh)

    // Hydraulic press 3D model
    const pressRng = new Rng(this.seed + 3)
    this.pressModel = new HydraulicPressModel(pressRng)
    this.world.add(this.pressModel.group)
    this.enableShadows(this.pressModel.group, true)

    // Object 3D model
    this.builtObject = this.buildObjectMesh(def.id)
    this.builtObject.root.position.set(0, this.pressModel.anvilTop, -this.builtObject.halfDepth)
    this.world.add(this.builtObject.root)
    this.enableShadows(this.builtObject.root, true)

    // Render-free logic
    this.logic = new PressLogic(def, capacity, this.seed)

    this.camPreset = 'wide'
    this.shake = 0
    this.shakeHold = 0
    this.slowMoFactor = 1
    this.slowMoUntil = 0
    this.previewTimer = 0
    this.flashIntensity = 0

    if (this.params.cameraMode === 'auto') {
      this.hostCameraEnabled = false
    } else {
      this.hostCameraEnabled = true
    }
  }

  private buildObjectMesh(id: string): BuiltObject {
    switch (id) {
      case 'sodaCan':
        return buildSodaCan()
      case 'rubberBall':
        return buildRubberBall()
      case 'glassCube':
        return buildGlassCube()
      case 'tungstenCube':
        return buildTungstenCube()
      case 'nokia3310':
      default:
        if (this.gltfModelScene && !this.isPreview) {
          return buildNokiaFromModel(this.gltfModelScene)
        }
        return buildProceduralNokia()
    }
  }

  override action(key: string): void {
    if (key === 'press' || key === 'start') {
      this.startPress()
    }
  }

  private startPress(): void {
    if (this.logic.state === 'idle') {
      this.logic.start()
      this.camPreset = 'close'
      this.events.emit({
        type: 'press_started',
        level: 'info',
        title: 'CYCLE STARTED',
        message: `${this.logic.object.name} under ${this.num('capacity')} t`,
      })
    }
  }

  protected override onParam(key: string, value: ParamValue): void {
    if (key === 'capacity') {
      this.logic.setCapacity(Number(value))
      this.pressModel.drawGauge(this.logic.force, Number(value))
    } else if (key === 'object') {
      const def = PRESS_OBJECT_DEFS[String(value)] || PRESS_OBJECT_DEFS.nokia3310
      this.builtObject.root.removeFromParent()
      this.builtObject.dispose()
      this.builtObject = this.buildObjectMesh(def.id)
      this.builtObject.root.position.set(0, this.pressModel.anvilTop, -this.builtObject.halfDepth)
      this.world.add(this.builtObject.root)
      this.enableShadows(this.builtObject.root, true)
      this.logic.setObject(def)
      this.camPreset = 'wide'
    } else if (key === 'cameraMode') {
      this.hostCameraEnabled = value !== 'auto'
    }
  }

  protected override update(dt: number): void {
    const timeScale = Number(this.params.timeScale) || 1
    const now = performance.now()
    if (now < this.slowMoUntil) {
      this.slowMoFactor += (0.25 - this.slowMoFactor) * Math.min(1, dt * 8)
    } else {
      this.slowMoFactor += (1 - this.slowMoFactor) * Math.min(1, dt * 3)
    }
    const scaledDt = dt * timeScale * this.slowMoFactor

    // Homepage preview auto-cycle
    if (this.isPreview) {
      this.previewTimer += dt
      if (this.logic.state === 'idle' && this.previewTimer > 1.2) {
        this.previewTimer = 0
        this.startPress()
      } else if ((this.logic.state === 'idle' && this.logic.outcome) || this.logic.state === 'failed') {
        if (this.previewTimer > 3.0) {
          this.previewTimer = 0
          this.rebuild()
        }
      }
    }

    this.logic.step(scaledDt)

    // Process logic events
    const events = this.logic.pollEvents()
    for (const ev of events) {
      switch (ev.type) {
        case 'contact':
          this.fx.sparks(new THREE.Vector3(0, this.logic.ramY, 0), 6, 80)
          this.builtObject.setScreen?.('idle', 1)
          this.events.emit({ type: 'ram_contact' })
          break
        case 'shatter':
          shatterObject(this.builtObject, this.logic.object, this.debris, this.fx, this.scene, this.rng)
          this.shake = Math.max(this.shake, 0.8)
          this.events.emit({
            type: 'shattered',
            level: 'info',
            title: 'SHATTERED',
            message: `${this.logic.object.name} failed under ${this.logic.force.toFixed(1)} t`,
          })
          break
        case 'strain_start':
          this.pressModel.beginStrain()
          this.events.emit({
            type: 'overload',
            level: 'warn',
            title: 'HYDRAULIC OVERLOAD',
            message: `Press stalled against ${this.logic.object.name}`,
          })
          break
        case 'bolt_pop':
          this.pressModel.launchBolt(this.debris, this.fx)
          this.shake = Math.max(this.shake, 0.4)
          this.events.emit({ type: 'bolt_pop' })
          break
        case 'explode':
          this.pressModel.explode(this.fx, this.debris)
          this.shake = 3.2
          this.slowMoUntil = performance.now() + 1800
          this.slowMoFactor = 0.22
          this.camPreset = 'chaos'
          this.flashIntensity = 0.85
          this.events.emit({
            type: 'press_destroyed',
            level: 'warn',
            title: 'PRESS DESTROYED',
            message: this.logic.object.failMessage || `${this.logic.object.name} won!`,
          })
          break
        case 'landed':
          this.builtObject.setScreen?.('victory', 1)
          this.events.emit({ type: 'nokia_survived' })
          break
        case 'complete':
          this.camPreset = 'wide'
          break
      }
    }

    // Update 3D press model
    this.pressModel.setRam(this.logic.ramY)
    if (this.logic.state === 'strain') {
      const k = this.logic.strainProgress
      this.pressModel.updateStrain(k, scaledDt, this.fx, this.builtObject.halfWidth, this.builtObject.halfDepth)
      this.shakeHold = 0.05 + k * k * 0.55
    } else {
      this.shakeHold = 0
    }
    this.pressModel.update(scaledDt, this.time, this.fx)
    this.pressModel.updateGauge(this.logic.force, Number(this.params.capacity), scaledDt)

    // Update object deformation & position
    if (!this.logic.broken) {
      applyCompression(this.builtObject, this.logic.compression, this.logic.object)
    }

    // Object drop during press explosion
    if (this.logic.dropping) {
      this.builtObject.root.position.y = this.logic.dropping.y
      this.builtObject.root.rotation.x = -this.logic.dropping.ang
    }

    // Update particle & debris systems
    this.fx.update(scaledDt)
    this.debris.update(scaledDt)

    // Camera preset updating
    if (this.params.cameraMode === 'auto') {
      if (this.logic.state === 'descend' || this.logic.state === 'load' || this.logic.state === 'strain' || this.logic.state === 'hold') {
        this.camPreset = 'close'
      } else if (this.logic.state === 'failed') {
        this.camPreset = 'chaos'
      } else {
        this.camPreset = 'wide'
      }

      const p = CAMS[this.camPreset]
      const k = 1 - Math.exp(-dt * 1.5)
      const aspect = this.camera.aspect || 1
      const pull = THREE.MathUtils.clamp(1.1 / Math.max(0.35, aspect), 1, 2.7)

      this.camTarget.set(p.target[0], p.target[1], p.target[2])
      const desiredPos = new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]).sub(this.camTarget).multiplyScalar(pull).add(this.camTarget)
      this.camPos.lerp(desiredPos, k)
      this.focus.lerp(this.camTarget, k)
    }

    // Screen flash decay
    if (this.flashIntensity > 0) {
      this.flashIntensity = Math.max(0, this.flashIntensity - dt * 1.4)
      const mat = this.flashMesh.material as THREE.MeshBasicMaterial
      mat.opacity = this.flashIntensity
    }
  }

  render(_alpha: number): void {
    // Restore camera position from previous shake offset
    this.camera.position.sub(this.lastShakeOffset)

    if (this.params.cameraMode === 'auto') {
      this.camera.position.copy(this.camPos)
      this.camera.lookAt(this.focus)
    }

    // Apply screen shake
    this.shake *= Math.exp(-0.016 * 3.5)
    const totalShake = this.shake + this.shakeHold
    if (totalShake > 0.001) {
      this.lastShakeOffset.set(
        (this.rng.next() - 0.5) * totalShake,
        (this.rng.next() - 0.5) * totalShake,
        (this.rng.next() - 0.5) * totalShake,
      )
      this.camera.position.add(this.lastShakeOffset)
    } else {
      this.lastShakeOffset.set(0, 0, 0)
    }
  }

  override resize(width: number, height: number): void {
    super.resize(width, height)
    this.updateParticleScale()
    if (this.params.cameraMode === 'auto') {
      const p = CAMS[this.camPreset]
      const aspect = this.camera.aspect || 1
      const pull = THREE.MathUtils.clamp(1.1 / Math.max(0.35, aspect), 1, 2.7)
      this.camTarget.set(p.target[0], p.target[1], p.target[2])
      const targetPos = new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]).sub(this.camTarget).multiplyScalar(pull).add(this.camTarget)
      this.camPos.copy(targetPos)
      this.focus.copy(this.camTarget)
      this.camera.position.copy(this.camPos)
      this.camera.lookAt(this.focus)
    }
  }

  private updateParticleScale(): void {
    if (!this.fx) return
    const fovRad = THREE.MathUtils.degToRad(this.camera.fov / 2)
    const pixelRatio = this.ctx?.renderer?.getPixelRatio() ?? 1
    const scale = (this.height * pixelRatio) / (2 * Math.tan(fovRad))
    this.fx.setScale(scale)
  }

  getStats(): Record<string, StatValue> {
    const f = this.logic.force
    return {
      state: this.logic.statusHead,
      force: f < 10 ? f.toFixed(2) : f.toFixed(1),
      pressure: this.logic.pressure.toFixed(1),
      compression: Math.round(this.logic.compression * 100),
      capacity: Number(this.params.capacity),
      object: this.logic.object.name,
    }
  }

  override entityCount(): number {
    return this.debris ? 10 + this.fx.sparksSys.max : 10
  }

  protected override teardown(): void {
    this.fx?.dispose()
    this.debris?.dispose()
    this.pressModel?.dispose()
    this.builtObject?.dispose()
  }
}
