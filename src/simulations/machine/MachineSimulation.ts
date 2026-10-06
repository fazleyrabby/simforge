import * as THREE from 'three'
import { makeIsoCamera } from '../../three/cameras'
import { mergeStaticMeshes } from '../../three/merge'
import { palette } from '../../three/palette'
import { BaseSimulation } from '../core/BaseSimulation'
import { Rng } from '../core/random'
import type { ParamValue, StatValue } from '../core/Simulation'
import { MachineLogic, STAGES, type MachineParams, type Piece, type PieceRole } from './MachineLogic'

/** The board spans x −11.4..11.2 and y −0.7..12; the scene is shifted so it sits centered. */
const CENTER_Y = 5.75
const BOARD_Z = -0.55
const CONFETTI = 90
/** Seconds between a run ending and the machine resetting itself. */
const RESET_DELAY = 4

const depthOf: Record<PieceRole, number> = {
  frame: 1.1,
  ramp: 0.9,
  stop: 0.9,
  marble: 0,
  ball: 0,
  domino: 0.7,
  bucket: 0.8,
  gate: 0.5,
  wheel: 0.6,
  hammer: 0.16,
  bell: 0,
  striker: 0,
  flap: 0.6,
  peg: 0,
}

function striped(base: string, band: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 32
  const context = canvas.getContext('2d')!
  context.fillStyle = base
  context.fillRect(0, 0, 64, 32)
  context.fillStyle = band
  context.fillRect(0, 12, 64, 8)
  context.fillRect(28, 0, 8, 32)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** A drawn piece that moves: its mesh and the physics shape it follows. */
interface Moving {
  piece: Piece
  mesh: THREE.Mesh
}

export default class MachineSimulation extends BaseSimulation {
  private logic!: MachineLogic
  /** Randomness for appearance only; never feeds the simulation. */
  private fx = new Rng(1)
  private moving: Moving[] = []
  private latch!: THREE.Mesh
  private rope!: THREE.LineSegments
  private ropePositions = new Float32Array(36)
  private pulleys: THREE.Mesh[] = []
  private lamps: THREE.MeshStandardMaterial[] = []
  private bell!: THREE.MeshStandardMaterial
  private bellFlash = 0
  private confetti!: THREE.InstancedMesh
  private confettiState: { x: number; y: number; vx: number; vy: number; spin: number; life: number }[] = []

  private startTimer = 0
  private endTimer = 0
  private runs = 0
  private completed = 0
  private best = 0
  private impactPeak = 0
  private keepCounters = false

  private grabbing: number | null = null
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private hit = new THREE.Vector3()
  private face = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
  private matrix = new THREE.Matrix4()
  private position = new THREE.Vector3()
  private scale = new THREE.Vector3()
  private quaternion = new THREE.Quaternion()
  private euler = new THREE.Euler()
  private color = new THREE.Color()

  constructor() {
    // Almost straight on: the machine is flat, with just enough angle to show its depth.
    super(makeIsoCamera(new THREE.Vector3(0.16, 0.12, 1)))
    this.params = { marbleMass: 1, rampAngle: 11, spacing: 0.55, ballast: 1, gravity: 10, autoRun: true }
  }

  protected build(): void {
    this.moving = []
    this.pulleys = []
    this.lamps = []
    this.bellFlash = 0
    this.startTimer = 0
    this.endTimer = 0
    this.impactPeak = 0
    this.grabbing = null
    this.fx = new Rng(this.seed + 11)
    if (!this.keepCounters) {
      this.runs = 0
      this.completed = 0
      this.best = 0
    }
    this.keepCounters = false
    this.world.position.y = -CENTER_Y

    this.logic = new MachineLogic(this.rng, this.readParams())
    this.logic.onStage = (stage) => this.events.emit({ type: stage === 1 ? 'machine_release' : 'machine_stage' })
    this.logic.onEnd = (status) => {
      this.runs++
      if (status === 'complete') {
        this.completed++
        this.best = this.best === 0 ? this.logic.runTime : Math.min(this.best, this.logic.runTime)
        this.bellFlash = 1
        this.burst()
        this.events.emit({
          type: 'machine_complete',
          level: 'info',
          title: 'CHAIN COMPLETE',
          message: `All ${STAGES.length} links fired in ${this.logic.runTime.toFixed(1)} s.`,
        })
      } else {
        this.events.emit({
          type: 'machine_stalled',
          level: 'warn',
          title: 'MACHINE STALLED',
          message: `The chain stopped after "${STAGES[this.logic.stage - 1]}". The next link never fired.`,
        })
      }
    }

    this.buildBoard()
    this.buildPieces()
    this.buildFittings()
    this.buildConfetti()

    this.enableShadows(this.world)
    this.confetti.castShadow = false
    this.lighting.setShadowExtent(15)
    this.setView(12.4, this.isPreview ? 7.3 : 8)

    const element = this.ctx.element
    if (element && !this.isPreview) {
      // Capture phase: these run before the camera controls and can claim the gesture.
      element.addEventListener('pointerdown', this.onPointerDown, true)
      element.addEventListener('pointermove', this.onPointerMove, true)
      element.addEventListener('pointerup', this.onPointerUp, true)
      element.addEventListener('pointercancel', this.onPointerUp, true)
    }
  }

  protected teardown(): void {
    const element = this.ctx?.element
    if (!element) return
    element.removeEventListener('pointerdown', this.onPointerDown, true)
    element.removeEventListener('pointermove', this.onPointerMove, true)
    element.removeEventListener('pointerup', this.onPointerUp, true)
    element.removeEventListener('pointercancel', this.onPointerUp, true)
    element.style.cursor = ''
  }

  protected update(dt: number): void {
    const { logic } = this
    logic.step(dt)
    this.impactPeak = Math.max(this.impactPeak * 0.9, logic.impact)
    this.bellFlash = Math.max(0, this.bellFlash - dt * 0.8)

    const auto = this.isPreview || this.bool('autoRun')
    if (logic.status === 'ready' && auto) {
      this.startTimer += dt
      if (this.startTimer > 1.4) logic.release()
    }
    if (logic.status === 'complete' || logic.status === 'stalled') {
      this.endTimer += dt
      if (auto && this.endTimer > RESET_DELAY && this.grabbing === null) {
        this.keepCounters = true
        this.rebuild()
        return
      }
    }

    for (const piece of this.confettiState) {
      if (piece.life <= 0) continue
      piece.life -= dt
      piece.vy -= 9 * dt
      piece.x += piece.vx * dt
      piece.y += piece.vy * dt
    }
  }

  render(_alpha: number): void {
    const { logic } = this
    for (const { piece, mesh } of this.moving) this.place(piece, mesh)

    this.latch.visible = logic.latched

    // Ropes: from one body up over both pulleys and down to the other, as three segments each.
    const ropes = logic.ropes
    let offset = 0
    for (const rope of ropes) {
      const [first, second] = rope.pulleys
      const points = [rope.a, [first[0], first[1] + 0.24], [second[0], second[1] + 0.24], rope.b]
      for (let i = 0; i < 3; i++) {
        this.ropePositions.set([points[i][0], points[i][1], 0, points[i + 1][0], points[i + 1][1], 0], offset)
        offset += 6
      }
    }
    this.rope.geometry.attributes.position.needsUpdate = true
    const turns = [logic.gateLift * 2.5, logic.gateLift * 2.5, logic.strikerLift, logic.strikerLift]
    this.pulleys.forEach((pulley, i) => (pulley.rotation.z = turns[i] / 0.24))

    // Progress lamps: green for links that fired, amber for the one in play, red where it stalled.
    const blink = Math.sin(this.time * 9) > 0 ? 1 : 0.25
    this.lamps.forEach((lamp, i) => {
      const fired = i < logic.stage
      const next = i === logic.stage && logic.status === 'running'
      const failed = i === logic.stage && logic.status === 'stalled'
      lamp.emissive.setHex(failed ? palette.red : fired ? palette.green : palette.amber)
      lamp.emissiveIntensity = failed ? 2.4 * blink : fired ? 1.8 : next ? 1.6 * blink : 0.06
    })
    this.bell.emissiveIntensity = this.bellFlash * 2.2

    let count = 0
    for (const piece of this.confettiState) {
      if (piece.life <= 0) continue
      this.euler.set(piece.spin * piece.life * 3, piece.spin * piece.life * 2, piece.spin * piece.life)
      this.quaternion.setFromEuler(this.euler)
      this.matrix.compose(this.position.set(piece.x, piece.y, 0.9), this.quaternion, this.scale.setScalar(Math.min(1, piece.life * 2)))
      this.confetti.setMatrixAt(count++, this.matrix)
    }
    this.confetti.count = count
    this.confetti.instanceMatrix.needsUpdate = true
  }

  protected onParam(key: string, _value: ParamValue): void {
    // Every control but the auto-run switch changes how the machine is built.
    if (key !== 'autoRun') this.rebuild()
  }

  action(key: string): void {
    if (key !== 'run') return
    if (this.logic.status !== 'ready') {
      this.keepCounters = true
      this.rebuild()
    }
    this.logic.release()
  }

  getStats(): Record<string, StatValue> {
    const { logic } = this
    const state = logic.status === 'ready' ? 'READY' : logic.status === 'running' ? 'RUNNING' : logic.status === 'complete' ? 'COMPLETE' : 'STALLED'
    return {
      state,
      stage: `${logic.stage} / ${STAGES.length}`,
      link: logic.stage > 0 ? STAGES[logic.stage - 1] : '—',
      elapsed: `${logic.runTime.toFixed(1)} s`,
      runs: this.runs > 0 ? `${this.completed} / ${this.runs}` : '—',
      best: this.best > 0 ? `${this.best.toFixed(1)} s` : '—',
      impact: Math.min(this.impactPeak, 20).toFixed(1),
    }
  }

  entityCount(): number {
    return this.moving.length
  }

  private readParams(): MachineParams {
    return {
      marbleMass: this.num('marbleMass'),
      rampAngle: this.num('rampAngle'),
      spacing: this.num('spacing'),
      ballast: this.num('ballast'),
      gravity: this.num('gravity'),
    }
  }

  private add(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(x, y, z)
    parent.add(mesh)
    return mesh
  }

  /** Moves a mesh to where its physics shape is. */
  private place(piece: Piece, mesh: THREE.Mesh): void {
    const { x, y } = piece.body.getPosition()
    const angle = piece.body.getAngle()
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    mesh.position.set(x + piece.x * cos - piece.y * sin, y + piece.x * sin + piece.y * cos, 0)
    mesh.rotation.z = angle + piece.angle
  }

  /** The pegboard everything is mounted on, and its frame. */
  private buildBoard(): void {
    const board = new THREE.MeshStandardMaterial({ color: 0x1a2028, roughness: 0.9 })
    const frame = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.5, roughness: 0.5 })
    this.add(this.world, new THREE.BoxGeometry(23.4, 14.1, 0.3), board, -0.1, CENTER_Y, BOARD_Z - 0.15)
    for (const y of [-1.45, 12.95]) this.add(this.world, new THREE.BoxGeometry(23.8, 0.3, 0.9), frame, -0.1, y, BOARD_Z + 0.15)
    for (const x of [-11.85, 11.65]) this.add(this.world, new THREE.BoxGeometry(0.3, 14.7, 0.9), frame, x, CENTER_Y, BOARD_Z + 0.15)

    // Peg holes.
    const columns = 38
    const rows = 23
    const holes = new THREE.InstancedMesh(new THREE.CircleGeometry(0.045, 8), new THREE.MeshBasicMaterial({ color: 0x0b0e12 }), columns * rows)
    let slot = 0
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        this.matrix.makeTranslation(-11.2 + column * 0.6, -0.85 + row * 0.6, BOARD_Z + 0.004)
        holes.setMatrixAt(slot++, this.matrix)
      }
    }
    this.world.add(holes)
  }

  /** One mesh per physics shape. Fixed pieces are merged; moving ones are tracked. */
  private buildPieces(): void {
    const wood = new THREE.MeshStandardMaterial({ color: 0xa9825a, roughness: 0.75 })
    const steel = new THREE.MeshStandardMaterial({ color: palette.steel, metalness: 0.6, roughness: 0.4 })
    const dark = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.5, roughness: 0.5 })
    const brick = new THREE.MeshStandardMaterial({ color: 0xb5483f, roughness: 0.7 })
    const bucket = new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.7, roughness: 0.35 })
    const gate = new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.6 })
    const blade = new THREE.MeshStandardMaterial({ color: palette.cyan, roughness: 0.5, metalness: 0.2 })
    const bob = new THREE.MeshStandardMaterial({ color: 0x8c2f2a, metalness: 0.4, roughness: 0.45 })
    this.bell = new THREE.MeshStandardMaterial({ color: 0xc9a54a, metalness: 0.9, roughness: 0.3, emissive: 0xffd27a, emissiveIntensity: 0 })
    const brass = new THREE.MeshStandardMaterial({ color: 0xb08d3c, metalness: 0.85, roughness: 0.35 })
    const flap = new THREE.MeshStandardMaterial({ color: palette.green, roughness: 0.55 })
    const tee = new THREE.MeshStandardMaterial({ map: striped('#f4a261', '#3b1d0a'), metalness: 0.3, roughness: 0.35 })
    const marble = new THREE.MeshStandardMaterial({ map: striped('#dfe5ec', '#3a86ff'), metalness: 0.5, roughness: 0.25 })
    const ball = new THREE.MeshStandardMaterial({ map: striped('#4cc9f0', '#0b2a36'), metalness: 0.3, roughness: 0.35 })
    const dominoMaterials = new Map<number, THREE.MeshStandardMaterial>()

    const fixed = new THREE.Group()
    this.world.add(fixed)
    for (const piece of this.logic.pieces) {
      let material: THREE.Material
      switch (piece.role) {
        case 'ramp':
          material = wood
          break
        case 'frame':
          material = dark
          break
        case 'stop':
          material = steel
          break
        case 'marble':
          material = marble
          break
        case 'ball':
          material = piece.variant === 1 ? tee : ball
          break
        case 'striker':
        case 'peg':
          material = brass
          break
        case 'flap':
          material = flap
          break
        case 'bucket':
          material = bucket
          break
        case 'gate':
          material = gate
          break
        case 'wheel':
          material = blade
          break
        case 'hammer':
          material = piece.shape === 'circle' ? bob : steel
          break
        case 'bell':
          material = this.bell
          break
        default: {
          if (piece.variant < 0) {
            material = brick
            break
          }
          // The first row runs from amber to violet; the second from cyan to green.
          let colored = dominoMaterials.get(piece.variant)
          if (!colored) {
            const second = piece.variant >= 10
            const step = (second ? piece.variant - 10 : piece.variant) / 6
            const hue = second ? 0.52 - step * 0.2 : (1.11 - step * 0.36) % 1
            colored = new THREE.MeshStandardMaterial({ color: this.color.setHSL(hue, 0.85, 0.58).getHex(), roughness: 0.5 })
            dominoMaterials.set(piece.variant, colored)
          }
          material = colored
        }
      }
      const geometry =
        piece.role === 'peg'
          ? new THREE.CylinderGeometry(piece.halfWidth, piece.halfWidth, 0.8, 12).rotateX(Math.PI / 2)
          : piece.shape === 'circle'
          ? new THREE.SphereGeometry(piece.halfWidth, 24, 16)
          : new THREE.BoxGeometry(piece.halfWidth * 2, piece.halfHeight * 2, depthOf[piece.role])
      const mesh = new THREE.Mesh(geometry, material)
      this.place(piece, mesh)
      if (piece.body.isDynamic()) {
        this.world.add(mesh)
        this.moving.push({ piece, mesh })
      } else {
        fixed.add(mesh)
      }
    }
    mergeStaticMeshes(fixed)
  }

  /** Hardware that is drawn but not simulated: latch, pulleys and rope, pivots, lamps. */
  private buildFittings(): void {
    const { logic } = this
    const steel = new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.75, roughness: 0.3 })
    const dark = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.5, roughness: 0.5 })
    const across = (radius: number, length: number, segments = 20) => {
      const geometry = new THREE.CylinderGeometry(radius, radius, length, segments)
      geometry.rotateX(Math.PI / 2)
      return geometry
    }

    this.latch = this.add(this.world, new THREE.BoxGeometry(0.12, 0.6, 0.5), new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.6 }), logic.latch.x, logic.latch.y, 0)
    this.latch.rotation.z = logic.latch.angle

    // Pulleys with spokes so their turning shows, on brackets off the board.
    const ropes = logic.ropes
    for (const [x, y] of ropes.flatMap((rope) => rope.pulleys)) {
      this.add(this.world, new THREE.BoxGeometry(0.16, 0.16, 0.7), dark, x, y, BOARD_Z + 0.35)
      const pulley = this.add(this.world, across(0.24, 0.16, 24), steel, x, y, 0)
      for (let i = 0; i < 3; i++) {
        const spoke = this.add(pulley, new THREE.BoxGeometry(0.4, 0.05, 0.18), dark, 0, 0, 0)
        spoke.rotation.z = (i * Math.PI) / 3
      }
      this.pulleys.push(pulley)
    }
    const ropeGeometry = new THREE.BufferGeometry()
    ropeGeometry.setAttribute('position', new THREE.BufferAttribute(this.ropePositions, 3))
    this.rope = new THREE.LineSegments(ropeGeometry, new THREE.LineBasicMaterial({ color: 0xd9c9a3 }))
    this.rope.frustumCulled = false
    this.world.add(this.rope)

    // Guide rails for the buckets, the gate and the striker.
    const rail = (x: number, low: number, high: number) => this.add(this.world, new THREE.BoxGeometry(0.06, high - low, 0.08), dark, x, (low + high) / 2, BOARD_Z + 0.1)
    for (const side of [-1, 1]) {
      rail(ropes[0].pulleys[0][0] + side * 0.82, 4.2, 8.6)
      rail(ropes[1].pulleys[0][0] + side * 0.82, -0.4, 2.6)
    }
    rail(ropes[0].pulleys[1][0], 7.3, 11.9)
    rail(ropes[1].pulleys[1][0], 4.6, 7.2)
    // Axles for the wheel, the flap and the hammer.
    for (const [x, y] of logic.pivots) {
      this.add(this.world, across(0.13, 0.85), dark, x, y, 0)
      this.add(this.world, new THREE.BoxGeometry(0.36, 0.36, 0.3), dark, x, y, BOARD_Z + 0.2)
    }
    // Bell hanger.
    const [bellX, bellY] = logic.bellAt
    this.add(this.world, new THREE.BoxGeometry(0.9, 0.1, 0.5), dark, bellX + 0.45, bellY + 0.5, BOARD_Z + 0.3)

    // A lamp per link in the chain, on the board under the long ramp.
    const pitch = 0.74
    const start = 5.6 - ((STAGES.length - 1) * pitch) / 2
    for (let i = 0; i < STAGES.length; i++) {
      const lamp = new THREE.MeshStandardMaterial({ color: 0x0b0d10, emissive: palette.amber, emissiveIntensity: 0.06 })
      this.add(this.world, across(0.17, 0.14, 16), lamp, start + i * pitch, 1.9, BOARD_Z + 0.1)
      this.lamps.push(lamp)
    }
    this.add(this.world, new THREE.BoxGeometry(STAGES.length * pitch + 0.3, 0.6, 0.06), dark, 5.6, 1.9, BOARD_Z + 0.02)
  }

  private buildConfetti(): void {
    this.confetti = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.16, 0.1), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }), CONFETTI)
    this.confetti.frustumCulled = false
    this.confetti.count = 0
    const colors = [palette.amber, palette.cyan, palette.green, palette.red, 0xc77dff, palette.white]
    this.confettiState = Array.from({ length: CONFETTI }, (_, i) => {
      this.confetti.setColorAt(i, this.color.setHex(colors[i % colors.length]))
      return { x: 0, y: 0, vx: 0, vy: 0, spin: 0, life: 0 }
    })
    this.world.add(this.confetti)
  }

  /** Confetti from the bell when the chain completes. */
  private burst(): void {
    for (const piece of this.confettiState) {
      const angle = this.fx.range(0.2, Math.PI - 0.2)
      const speed = this.fx.range(3, 9)
      piece.x = this.logic.bellAt[0]
      piece.y = this.logic.bellAt[1]
      piece.vx = Math.cos(angle) * speed
      piece.vy = Math.sin(angle) * speed
      piece.spin = this.fx.range(-4, 4)
      piece.life = this.fx.range(1.6, 3)
    }
  }

  /** Board coordinates under the pointer. */
  private boardPoint(event: PointerEvent): { x: number; y: number } | null {
    const element = this.ctx.element
    if (!element) return null
    const rect = element.getBoundingClientRect()
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    if (!this.raycaster.ray.intersectPlane(this.face, this.hit)) return null
    return { x: this.hit.x, y: this.hit.y + CENTER_Y }
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || event.altKey) return
    const point = this.boardPoint(event)
    // Only a press on a movable piece is claimed; anywhere else still moves the camera.
    if (!point || !this.logic.grab(point.x, point.y)) return
    event.stopImmediatePropagation()
    event.preventDefault()
    this.grabbing = event.pointerId
    this.ctx.element?.setPointerCapture(event.pointerId)
    if (this.ctx.element) this.ctx.element.style.cursor = 'grabbing'
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (this.grabbing !== event.pointerId) return
    event.stopImmediatePropagation()
    const point = this.boardPoint(event)
    if (point) this.logic.drag(point.x, point.y)
  }

  private onPointerUp = (event: PointerEvent): void => {
    if (this.grabbing !== event.pointerId) return
    event.stopImmediatePropagation()
    this.grabbing = null
    this.logic.drop()
    if (this.ctx.element) this.ctx.element.style.cursor = ''
  }
}
