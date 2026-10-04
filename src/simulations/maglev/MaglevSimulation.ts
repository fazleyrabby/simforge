import * as THREE from 'three'
import { makeIsoCamera } from '../../three/cameras'
import { palette } from '../../three/palette'
import { makePlinth } from '../../three/plinth'
import { BaseSimulation } from '../core/BaseSimulation'
import type { ParamValue, StatValue } from '../core/Simulation'
import { MaglevModel, type MaglevParams } from './MaglevModel'
import { MaglevScope } from './MaglevScope'

const COIL_FACE = 5.55
const GAP_SCALE = 1.5
const BALL_RADIUS = 0.37

export default class MaglevSimulation extends BaseSimulation {
  private model!: MaglevModel
  private ball!: THREE.Group
  private targetMarker!: THREE.Group
  private scope!: MaglevScope
  private copper!: THREE.MeshStandardMaterial
  private fieldLines: THREE.Line[] = []
  private sampleTick = 0
  private beam!: THREE.Mesh
  private coilLed!: THREE.MeshStandardMaterial
  private lastCatchEvent = -Infinity

  constructor() {
    super(makeIsoCamera(new THREE.Vector3(0.95, 0.66, 1.25)))
    this.params = { mode: 'auto', target: 0.8, current: 0, gain: 1, mass: 0.08, fields: true }
  }

  protected build(): void {
    this.model = new MaglevModel(this.readParams())
    this.fieldLines = []
    this.sampleTick = 0
    this.lastCatchEvent = -Infinity
    this.world.position.y = -2.9
    const steel = new THREE.MeshStandardMaterial({ color: palette.steel, metalness: 0.72, roughness: 0.31 })
    const dark = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.68, roughness: 0.39 })
    const black = new THREE.MeshStandardMaterial({ color: palette.rubber, roughness: 0.88 })
    const amber = new THREE.MeshStandardMaterial({ color: palette.amber, metalness: 0.33, roughness: 0.36, emissive: palette.amber, emissiveIntensity: 0.16 })
    const cyan = new THREE.MeshStandardMaterial({ color: palette.cyan, emissive: palette.cyan, emissiveIntensity: 0.46 })
    this.copper = new THREE.MeshStandardMaterial({ color: 0xb96b35, metalness: 0.79, roughness: 0.23, emissive: 0x8a3410, emissiveIntensity: 0.09 })

    this.world.add(makePlinth(11.6, 7.2))
    this.buildFloor(dark, steel, amber)
    this.buildGantry(steel, dark, black, amber)
    this.buildCoil(steel, dark, black, cyan)
    this.buildCatch(steel, dark, amber)
    this.buildRuler(steel, dark, amber)
    this.buildBall(steel)
    this.buildField()

    this.scope = new MaglevScope(this.isPreview)
    this.world.add(this.scope.group)
    // Power and sense leads visibly connect the controller to the head assembly.
    const lead = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.6, 6.35, -0.25),
      new THREE.Vector3(1.8, 6.47, -0.3),
      new THREE.Vector3(2.65, 4.3, -0.3),
      new THREE.Vector3(3.95, 2.13, -1.75),
    ]), 48, 0.055, 8, false), black)
    this.world.add(lead)

    this.enableShadows(this.world)
    this.lighting.setShadowExtent(12)
    this.focus.set(0, 0.35, 0)
    this.setView(6.7, this.isPreview ? 5.8 : 5.4)
    this.render(0)
  }

  protected update(dt: number): void {
    const before = this.model.catches
    this.model.step(dt)
    if (this.model.catches > before && this.model.time - this.lastCatchEvent > 2) {
      this.lastCatchEvent = this.model.time
      this.events.emit({ type: 'ball_caught', level: 'warn', title: 'BALL CAUGHT', message: 'The ball reached the safety tray. Increase current or switch to feedback control.' })
    }
    if (++this.sampleTick % (this.isPreview ? 6 : 3) === 0) {
      this.scope.sample(this.model.gap, this.model.params.target, this.model.current, this.model.status)
    }
  }

  render(_alpha: number): void {
    if (!this.model || !this.ball) return
    const ballY = COIL_FACE - this.model.gap * GAP_SCALE
    this.ball.position.y = ballY
    this.targetMarker.position.y = COIL_FACE - this.model.params.target * GAP_SCALE
    const beamLength = Math.max(0.15, COIL_FACE - ballY)
    this.beam.position.y = (COIL_FACE + ballY) / 2
    this.beam.scale.y = beamLength
    const strength = THREE.MathUtils.clamp(this.model.current / 4.5, 0, 1)
    const hot = THREE.MathUtils.clamp((this.model.temperature - 30) / 75, 0, 1)
    this.copper.emissiveIntensity = 0.09 + hot * 0.62
    this.coilLed.emissiveIntensity = 0.2 + strength * 1.8
    this.coilLed.color.setHex(strength < 0.15 ? palette.steelDark : palette.cyan)
    const showField = this.bool('fields') && strength > 0.04
    for (let i = 0; i < this.fieldLines.length; i++) {
      const line = this.fieldLines[i]
      line.visible = showField
      if (!showField) continue
      const material = line.material as THREE.LineBasicMaterial
      material.opacity = 0.12 + strength * 0.45
      const points = line.geometry.attributes.position as THREE.BufferAttribute
      const side = i % 2 === 0 ? -1 : 1
      const lane = Math.floor(i / 2)
      const spread = 0.2 + lane * 0.16
      const z = (lane % 3 - 1) * 0.26
      for (let n = 0; n < points.count; n++) {
        const t = n / (points.count - 1)
        const x = side * (0.48 + spread * Math.sin(Math.PI * t)) * (1 - 0.42 * t)
        const y = COIL_FACE - (COIL_FACE - ballY - BALL_RADIUS * 0.75) * t
        points.setXYZ(n, x, y, z)
      }
      points.needsUpdate = true
    }
  }

  protected onParam(key: string, _value: ParamValue): void {
    this.model.params = this.readParams()
    if (key === 'mode' || key === 'mass') {
      this.model.reset()
      this.scope.clear(this.model.params.target)
    }
  }

  action(key: string): void {
    if (key !== 'tap') return
    this.model.nudge()
    this.events.emit({ type: 'ball_tapped', level: 'info', title: 'DISTURBANCE', message: 'A downward impulse tests how quickly the controller recovers.' })
  }

  getStats(): Record<string, StatValue> {
    return {
      gap: (this.model.gap * 100).toFixed(1),
      target: (this.model.params.target * 100).toFixed(1),
      error: (this.model.error * 100).toFixed(1),
      current: this.model.current.toFixed(2),
      force: this.model.force.toFixed(2),
      velocity: this.model.velocity.toFixed(2),
      coilTemp: this.model.temperature.toFixed(1),
      state: this.model.status,
      catches: this.model.catches,
      elapsed: `${this.model.time.toFixed(1)} s`,
    }
  }

  entityCount(): number { return 1 }

  private readParams(): MaglevParams {
    return {
      mode: this.params.mode === 'manual' ? 'manual' : 'auto',
      target: this.num('target'),
      current: this.num('current'),
      gain: this.num('gain'),
      mass: this.num('mass'),
    }
  }

  private buildFloor(dark: THREE.Material, steel: THREE.Material, amber: THREE.Material): void {
    for (let i = -5; i <= 5; i++) {
      this.box(this.world, 0.018, 0.014, i % 2 === 0 ? 0.3 : 0.16, i === 0 ? amber : steel, i * 0.48, 0.015, 2.82)
    }
    for (const x of [-2.45, 2.45]) {
      this.box(this.world, 0.15, 0.03, 4.8, dark, x, 0.02, 0)
    }
  }

  private buildGantry(steel: THREE.Material, dark: THREE.Material, black: THREE.Material, amber: THREE.Material): void {
    for (const x of [-1.9, 1.9]) {
      for (const z of [-1.15, 1.15]) {
        this.box(this.world, 0.8, 0.16, 0.8, amber, x, 0.1, z)
        this.box(this.world, 0.18, 5.93, 0.18, steel, x, 3.12, z)
        this.box(this.world, 0.3, 0.1, 0.3, dark, x, 6.12, z)
        if (!this.isPreview) {
          for (const dx of [-0.25, 0.25]) for (const dz of [-0.25, 0.25]) this.bolt(x + dx, 0.22, z + dz, dark)
        }
      }
    }
    for (const z of [-1.15, 1.15]) {
      this.box(this.world, 4.15, 0.2, 0.2, dark, 0, 6.12, z)
      this.box(this.world, 4.15, 0.06, 0.075, amber, 0, 6.25, z + 0.09)
    }
    for (const x of [-1.9, 1.9]) this.box(this.world, 0.2, 0.18, 2.5, dark, x, 6.12, 0)
    this.box(this.world, 1.7, 0.16, 2.1, steel, 0, 6.27, 0)
    this.box(this.world, 0.55, 0.11, 0.55, black, 0, 6.41, 0)
  }

  private buildCoil(steel: THREE.Material, dark: THREE.Material, black: THREE.Material, cyan: THREE.Material): void {
    this.box(this.world, 1.82, 0.28, 1.7, dark, 0, 6.04, 0)
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.95, 24), steel)
    core.position.y = 5.98
    this.world.add(core)
    for (const y of [5.51, 6.4]) {
      const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.76, 0.76, 0.1, 28), dark)
      flange.position.y = y
      this.world.add(flange)
    }
    const turns = this.isPreview ? 12 : 26
    for (let i = 0; i < turns; i++) {
      const turn = new THREE.Mesh(new THREE.TorusGeometry(0.63, 0.047, 8, 30), this.copper)
      turn.rotation.x = Math.PI / 2
      turn.position.y = 5.58 + i * 0.031
      this.world.add(turn)
    }
    this.box(this.world, 0.5, 0.11, 0.25, black, 1.07, 5.93, 0)
    this.coilLed = new THREE.MeshStandardMaterial({ color: palette.cyan, emissive: palette.cyan, emissiveIntensity: 0.4 })
    this.box(this.world, 0.15, 0.11, 0.07, this.coilLed, 1.08, 5.94, 0.16)
    const sensor = this.box(this.world, 0.24, 0.12, 0.31, black, 1.38, COIL_FACE, 0.45)
    sensor.castShadow = false
    this.box(this.world, 0.1, 0.06, 0.08, cyan, 1.38, COIL_FACE - 0.04, 0.63)
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 6), new THREE.MeshBasicMaterial({ color: palette.cyan, transparent: true, opacity: 0.45, depthWrite: false }))
    this.beam.position.x = 1.38
    this.beam.position.z = 0.5
    this.world.add(this.beam)
  }

  private buildCatch(steel: THREE.Material, dark: THREE.Material, amber: THREE.Material): void {
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 1.46, 16), dark)
    stem.position.y = 0.85
    this.world.add(stem)
    const tray = new THREE.Mesh(new THREE.CylinderGeometry(1.18, 1.05, 0.16, 32), dark)
    tray.position.y = 1.65
    tray.receiveShadow = true
    this.world.add(tray)
    const inset = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.025, 32), steel)
    inset.position.y = 1.75
    this.world.add(inset)
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1.08, 0.055, 8, 32), amber)
    rim.rotation.x = Math.PI / 2
    rim.position.y = 1.77
    this.world.add(rim)
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2
      this.bolt(Math.cos(a) * 0.92, 1.785, Math.sin(a) * 0.92, dark)
    }
  }

  private buildRuler(steel: THREE.Material, dark: THREE.Material, amber: THREE.Material): void {
    this.box(this.world, 0.12, 3.68, 0.16, dark, -2.55, 3.75, 0.9)
    for (let n = 0; n <= 19; n++) {
      const y = COIL_FACE - n * 0.18
      this.box(this.world, n % 5 === 0 ? 0.34 : 0.17, 0.018, 0.02, n % 5 === 0 ? amber : steel, -2.42, y, 1.0)
    }
    this.targetMarker = new THREE.Group()
    this.world.add(this.targetMarker)
    this.box(this.targetMarker, 0.5, 0.06, 0.22, amber, -2.27, 0, 1.05)
    this.box(this.targetMarker, 0.1, 0.18, 0.2, amber, -2.55, 0, 1.05)
  }

  private buildBall(steel: THREE.Material): void {
    this.ball = new THREE.Group()
    this.world.add(this.ball)
    const metal = new THREE.MeshStandardMaterial({ color: 0xcad4de, metalness: 0.92, roughness: 0.16, envMapIntensity: 1.25 })
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, this.isPreview ? 20 : 40, this.isPreview ? 16 : 30), metal)
    sphere.castShadow = true
    this.ball.add(sphere)
    const equator = new THREE.Mesh(new THREE.TorusGeometry(BALL_RADIUS + 0.003, 0.012, 6, 48), steel)
    equator.rotation.x = Math.PI / 2
    this.ball.add(equator)
    for (const x of [-0.12, 0.12]) {
      const mark = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), new THREE.MeshBasicMaterial({ color: palette.cyan }))
      mark.position.set(x, -0.3, 0.18)
      this.ball.add(mark)
    }
  }

  private buildField(): void {
    const count = this.isPreview ? 8 : 16
    for (let i = 0; i < count; i++) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(40 * 3), 3))
      const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: i % 4 === 0 ? palette.amber : palette.cyan, transparent: true, opacity: 0.3, depthWrite: false }))
      this.world.add(line)
      this.fieldLines.push(line)
    }
  }

  private bolt(x: number, y: number, z: number, material: THREE.Material): void {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 6), material)
    mesh.position.set(x, y, z)
    this.world.add(mesh)
  }

  private box(parent: THREE.Object3D, w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material)
    mesh.position.set(x, y, z)
    mesh.castShadow = true
    mesh.receiveShadow = true
    parent.add(mesh)
    return mesh
  }
}
