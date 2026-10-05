import * as THREE from 'three'
import { makeIsoCamera } from '../../three/cameras'
import { mergeStaticMeshes } from '../../three/merge'
import { palette } from '../../three/palette'
import { makePlinth } from '../../three/plinth'
import { BaseSimulation } from '../core/BaseSimulation'
import type { ParamValue, StatValue } from '../core/Simulation'
import {
  ARM,
  ArmLogic,
  BELT_LENGTH,
  BELT_START,
  BELT_TOP,
  BELT_Z,
  BIN_FLOOR,
  PART_HEIGHT,
  PART_SIZE,
  type ArmParams,
  type Phase,
  type Point,
} from './ArmLogic'

const MAX_PARTS = 80
const TRACE_POINTS = 260
const REACH = ARM.upper + ARM.fore
/** The scene is lowered so the arm's working volume sits in the middle of the view. */
const DROP = 1.5
const GRAB_RADIUS = 34

const binColors = [0x4cc9f0, 0xffb020, 0xc77dff]
const binNames = ['A', 'B', 'C']

const phaseLabel: Record<Phase, string> = {
  toPick: 'MOVE TO PICK',
  awaitPart: 'WAITING FOR PART',
  descendPick: 'APPROACH',
  grip: 'GRIP',
  liftPick: 'RETRACT',
  toPlace: 'MOVE TO PALLET',
  descendPlace: 'APPROACH',
  release: 'RELEASE',
  liftPlace: 'RETRACT',
  manual: 'MANUAL',
}

export default class ArmSimulation extends BaseSimulation {
  private logic!: ArmLogic
  private target: Point = [1.8, 1.6, 1.4]

  private yaw!: THREE.Group
  private shoulder!: THREE.Group
  private elbow!: THREE.Group
  private wrist!: THREE.Group
  private roll!: THREE.Group
  private fingers: THREE.Mesh[] = []
  private baseRing!: THREE.MeshStandardMaterial

  private partMesh!: THREE.InstancedMesh
  private beltTexture: THREE.Texture | null = null
  private beam!: THREE.MeshStandardMaterial
  private stack: THREE.MeshStandardMaterial[] = []
  private binLamps: THREE.MeshStandardMaterial[] = []
  private binFlash = [0, 0, 0]
  private trace!: THREE.Line
  private tracePositions = new Float32Array(TRACE_POINTS * 3)
  private traceCount = 0
  private envelope!: THREE.Group
  private marker!: THREE.Group
  private markerMaterial!: THREE.MeshBasicMaterial
  private hmi: { texture: THREE.CanvasTexture; context: CanvasRenderingContext2D } | null = null
  private hmiTimer = 0
  private wasReachable = true

  private dragging: number | null = null
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private hit = new THREE.Vector3()
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private projected = new THREE.Vector3()
  private matrix = new THREE.Matrix4()
  private color = new THREE.Color()

  constructor() {
    super(makeIsoCamera(new THREE.Vector3(0.72, 0.78, 1)))
    this.params = { mode: 'auto', speed: 1, feedRate: 12, height: 1.6, trace: true, envelope: true }
  }

  protected build(): void {
    this.fingers = []
    this.stack = []
    this.binLamps = []
    this.binFlash = [0, 0, 0]
    this.traceCount = 0
    this.dragging = null
    this.hmiTimer = 0
    this.wasReachable = true
    this.target = [1.8, this.num('height'), 1.4]
    this.world.position.y = -DROP

    this.logic = new ArmLogic(this.rng, this.readParams())
    this.logic.onGrip = (closing) => this.events.emit({ type: closing ? 'grip_close' : 'grip_open' })
    this.logic.onPallet = (bin) => {
      this.binFlash[bin] = 1
      this.events.emit({
        type: 'pallet_full',
        level: 'info',
        title: 'PALLET FULL',
        message: `Pallet ${binNames[bin]} holds twelve parts and is swapped for an empty one.`,
      })
    }

    const floor = makePlinth(17.5, 12.5)
    floor.position.x = -1.3
    this.world.add(floor)
    this.buildFloor()
    this.buildConveyor()
    this.buildPallets()
    this.buildGuarding()
    this.buildCabinet()
    mergeStaticMeshes(this.world)

    this.buildArm()
    this.buildOverlays()

    this.enableShadows(this.world)
    this.trace.castShadow = false
    this.lighting.setShadowExtent(11)
    this.setView(this.isPreview ? 7.2 : 8.6, this.isPreview ? 4.4 : 5.6)

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
    this.beltTexture = null
    this.hmi = null
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

    // The gripper tip leaves a trace of where it has been.
    const [x, y, z] = logic.tip
    if (this.traceCount === TRACE_POINTS) {
      this.tracePositions.copyWithin(0, 3)
      this.traceCount--
    }
    this.tracePositions.set([x, y, z], this.traceCount * 3)
    this.traceCount++

    for (let i = 0; i < 3; i++) this.binFlash[i] = Math.max(0, this.binFlash[i] - dt * 0.7)

    if (logic.phase === 'manual' && logic.reachable !== this.wasReachable) {
      this.wasReachable = logic.reachable
      if (!logic.reachable) {
        this.events.emit({
          type: 'out_of_reach',
          level: 'warn',
          title: 'OUT OF REACH',
          message: 'That point is outside the arm\'s working envelope. It stretches as far as it can.',
        })
      }
    }

    this.hmiTimer += dt
    if (this.hmiTimer >= 0.1) {
      this.hmiTimer = 0
      this.drawHmi()
    }
  }

  render(_alpha: number): void {
    const { logic } = this
    const [yaw, shoulder, elbow, wrist] = logic.joints
    this.yaw.rotation.y = -yaw
    this.shoulder.rotation.z = shoulder
    this.elbow.rotation.z = elbow
    this.wrist.rotation.z = wrist
    // Counter-rotate the gripper so its jaws stay square to the cell while the base turns.
    this.roll.rotation.x = -yaw
    const gap = PART_SIZE / 2 + 0.035 + logic.grip * 0.13
    this.fingers[0].position.z = gap
    this.fingers[1].position.z = -gap

    // Parts.
    let count = 0
    for (const part of logic.parts) {
      if (count >= MAX_PARTS) break
      this.matrix.makeTranslation(part.x, part.y, part.z)
      this.partMesh.setMatrixAt(count, this.matrix)
      this.partMesh.setColorAt(count, this.color.setHex(binColors[part.color]))
      count++
    }
    this.partMesh.count = count
    this.partMesh.instanceMatrix.needsUpdate = true
    if (this.partMesh.instanceColor) this.partMesh.instanceColor.needsUpdate = true

    if (this.beltTexture) this.beltTexture.offset.x = -this.time * 1.3 * 2

    // Gate sensor: red while a part is blocking the beam.
    const waiting = logic.beltParts[0]?.s >= BELT_LENGTH - 0.01
    this.beam.emissive.setHex(waiting ? palette.red : palette.green)

    // Stack light: green running, amber waiting or manual, red out of reach.
    const moving = logic.effort > 0.02
    const fault = logic.phase === 'manual' && !logic.reachable
    this.stack[0].emissiveIntensity = fault ? 2.6 : 0.05
    this.stack[1].emissiveIntensity = !fault && (logic.phase === 'manual' || logic.phase === 'awaitPart') ? 2.2 : 0.05
    this.stack[2].emissiveIntensity = !fault && logic.phase !== 'manual' && logic.phase !== 'awaitPart' ? 2.2 : 0.05
    this.baseRing.emissiveIntensity = 0.5 + (moving ? Math.min(1, logic.effort) * 1.8 : 0)

    this.binLamps.forEach((lamp, i) => {
      const swapping = logic.bins[i].swap > 0
      lamp.emissiveIntensity = swapping ? 1.5 + Math.sin(this.time * 18) * 1.2 : 0.6 + this.binFlash[i] * 2
    })

    this.trace.visible = this.bool('trace')
    this.trace.geometry.setDrawRange(0, this.traceCount)
    this.trace.geometry.attributes.position.needsUpdate = true
    this.envelope.visible = this.bool('envelope')

    this.marker.visible = logic.phase === 'manual'
    this.marker.position.set(this.target[0], this.target[1], this.target[2])
    this.markerMaterial.color.setHex(logic.reachable ? palette.cyan : palette.red)
  }

  protected onParam(key: string, value: ParamValue): void {
    if (key === 'mode') {
      const manual = value === 'manual'
      if (manual) {
        // Start the target where the gripper already is, so the arm does not lurch.
        const [x, y, z] = this.logic.tip
        this.target = [x, THREE.MathUtils.clamp(y, 0.5, 3.4), z]
      }
      this.logic.params = this.readParams()
      this.logic.setManual(manual)
      return
    }
    if (key === 'height') this.target = [this.target[0], this.num('height'), this.target[2]]
    this.logic.params = this.readParams()
  }

  action(key: string): void {
    if (key !== 'grip') return
    if (this.logic.phase !== 'manual') {
      this.events.emit({
        type: 'grip_locked',
        level: 'info',
        title: 'AUTOMATIC MODE',
        message: 'The gripper is under program control. Switch Mode to Manual to use it by hand.',
      })
      return
    }
    this.logic.toggleGrip()
  }

  getStats(): Record<string, StatValue> {
    const { logic } = this
    const [x, y, z] = logic.tip
    const degrees = logic.joints.map((angle) => Math.round((angle * 180) / Math.PI))
    const stretch = Math.hypot(Math.hypot(x, z), y + ARM.tool - ARM.shoulderHeight) / REACH
    return {
      state: phaseLabel[logic.phase],
      cycle: logic.lastCycle > 0 ? `${logic.lastCycle.toFixed(1)} s` : '—',
      rate: `${logic.throughput().toFixed(0)} / min`,
      placed: logic.placed,
      pallets: logic.pallets,
      queue: logic.beltParts.length,
      joints: degrees.join(' / '),
      tip: `${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}`,
      stretch: (stretch * 100).toFixed(0),
      effort: (Math.min(logic.effort, 1.5) * 100).toFixed(0),
      missorted: logic.missorted,
    }
  }

  entityCount(): number {
    return this.logic.parts.length + 1
  }

  private readParams(): ArmParams {
    return {
      manual: this.params.mode === 'manual',
      speed: this.num('speed'),
      feedRate: this.num('feedRate'),
      target: this.target,
    }
  }

  private add(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(x, y, z)
    parent.add(mesh)
    return mesh
  }

  /** Painted floor: the cell's safety boundary and a mat at the operator's side. */
  private buildFloor(): void {
    const stripe = new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.8 })
    // A ring on the floor at the limit of the arm's reach.
    const ring = new THREE.RingGeometry(REACH + 0.25, REACH + 0.37, 96)
    ring.rotateX(-Math.PI / 2)
    this.add(this.world, ring, stripe, 0, 0.012, 0)
    this.add(this.world, new THREE.BoxGeometry(4.2, 0.03, 1.4), new THREE.MeshStandardMaterial({ color: 0x11161b, roughness: 0.95 }), 4.2, 0.016, 4.2)
  }

  /** Infeed conveyor: belt, rails, legs, the stop gate and its photoelectric sensor. */
  private buildConveyor(): void {
    const steel = new THREE.MeshStandardMaterial({ color: palette.steel, metalness: 0.55, roughness: 0.45 })
    const dark = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.5, roughness: 0.55 })
    const length = BELT_LENGTH + 0.9
    const centerX = BELT_START + length / 2 - 0.45

    this.add(this.world, new THREE.BoxGeometry(length, 0.26, 1), dark, centerX, BELT_TOP - 0.15, BELT_Z)
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 8
    const context = canvas.getContext('2d')!
    context.fillStyle = '#20252c'
    context.fillRect(0, 0, 32, 8)
    context.fillStyle = '#2f3741'
    context.fillRect(0, 0, 5, 8)
    const texture = new THREE.CanvasTexture(canvas)
    texture.wrapS = THREE.RepeatWrapping
    texture.repeat.set(length * 2, 1)
    texture.colorSpace = THREE.SRGBColorSpace
    this.beltTexture = texture
    const belt = this.add(this.world, new THREE.PlaneGeometry(length, 0.8), new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95 }), centerX, BELT_TOP - 0.012, BELT_Z)
    belt.rotation.x = -Math.PI / 2
    for (const side of [-1, 1]) this.add(this.world, new THREE.BoxGeometry(length, 0.14, 0.07), steel, centerX, BELT_TOP + 0.03, BELT_Z + side * 0.47)
    for (let i = 0; i < 5; i++) {
      for (const side of [-1, 1]) {
        this.add(this.world, new THREE.BoxGeometry(0.12, BELT_TOP - 0.28, 0.12), dark, BELT_START + 0.2 + i * 1.75, (BELT_TOP - 0.28) / 2, BELT_Z + side * 0.4)
      }
    }
    // Drive motor at the head of the belt.
    const motor = new THREE.CylinderGeometry(0.2, 0.2, 0.5, 14)
    motor.rotateX(Math.PI / 2)
    this.add(this.world, motor, new THREE.MeshStandardMaterial({ color: 0x2b4f73, metalness: 0.4, roughness: 0.5 }), BELT_START + BELT_LENGTH + 0.2, BELT_TOP - 0.2, BELT_Z + 0.78)

    // Stop gate and sensor posts at the pick point.
    const gateX = BELT_START + BELT_LENGTH + PART_SIZE / 2 + 0.05
    this.add(this.world, new THREE.BoxGeometry(0.06, 0.34, 0.8), steel, gateX, BELT_TOP + 0.17, BELT_Z)
    for (const side of [-1, 1]) {
      this.add(this.world, new THREE.BoxGeometry(0.1, 0.5, 0.1), dark, gateX - 0.3, BELT_TOP + 0.25, BELT_Z + side * 0.58)
    }
    this.beam = new THREE.MeshStandardMaterial({ color: 0x140606, emissive: palette.green, emissiveIntensity: 2.2 })
    this.add(this.world, new THREE.BoxGeometry(0.02, 0.02, 1.06), this.beam, gateX - 0.3, BELT_TOP + 0.24, BELT_Z)

    // Parts come in through a hood at the far end.
    const hoodX = BELT_START - 0.1
    this.add(this.world, new THREE.BoxGeometry(1.2, 0.12, 1.3), steel, hoodX, BELT_TOP + 1, BELT_Z)
    for (const side of [-1, 1]) this.add(this.world, new THREE.BoxGeometry(1.2, 1.9, 0.1), steel, hoodX, 0.95, BELT_Z + side * 0.6)
    for (let i = 0; i < 5; i++) {
      this.add(this.world, new THREE.BoxGeometry(0.03, 0.62, 0.17), new THREE.MeshStandardMaterial({ color: 0x15191e, roughness: 0.8 }), hoodX + 0.6, BELT_TOP + 0.62, BELT_Z - 0.4 + i * 0.2)
    }
  }

  /** Three colour-coded pallets, each with a lamp post that flashes when it is swapped. */
  private buildPallets(): void {
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b4f33, roughness: 0.9 })
    const dark = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.5, roughness: 0.55 })
    this.logic.bins.forEach((bin, i) => {
      // Deck boards on three runners: the deck's top is the pallet floor.
      for (let board = 0; board < 5; board++) {
        this.add(this.world, new THREE.BoxGeometry(0.34, 0.06, 1.5), wood, bin.x - 0.84 + board * 0.42, BIN_FLOOR - 0.03, bin.z)
      }
      for (const runner of [-1, 0, 1]) {
        this.add(this.world, new THREE.BoxGeometry(2.1, BIN_FLOOR - 0.06, 0.16), wood, bin.x, (BIN_FLOOR - 0.06) / 2, bin.z + runner * 0.62)
      }
      // Painted bay outline in the pallet's colour.
      const paint = new THREE.MeshStandardMaterial({ color: binColors[i], roughness: 0.8 })
      for (const side of [-1, 1]) {
        this.add(this.world, new THREE.BoxGeometry(2.5, 0.02, 0.08), paint, bin.x, 0.012, bin.z + side * 0.95)
        this.add(this.world, new THREE.BoxGeometry(0.08, 0.02, 1.98), paint, bin.x + side * 1.25, 0.012, bin.z)
      }
      // Lamp post with the bay's letter.
      const outward = Math.sign(bin.z) || -1
      const postX = bin.x + (bin.x === 0 ? 1.45 : Math.sign(bin.x) * 1.45)
      const postZ = bin.z + outward * 0.5
      this.add(this.world, new THREE.BoxGeometry(0.1, 1.5, 0.1), dark, postX, 0.75, postZ)
      const lamp = new THREE.MeshStandardMaterial({ color: 0x0b0d10, emissive: binColors[i], emissiveIntensity: 0.6 })
      this.add(this.world, new THREE.BoxGeometry(0.42, 0.42, 0.06), lamp, postX, 1.6, postZ + 0.05)
      this.binLamps.push(lamp)
      const sign = this.add(this.world, new THREE.PlaneGeometry(0.34, 0.34), this.letter(binNames[i]), postX, 1.6, postZ + 0.085)
      sign.renderOrder = 1
    })
  }

  private letter(text: string): THREE.MeshBasicMaterial {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 64
    const context = canvas.getContext('2d')!
    context.fillStyle = '#0a0c0f'
    context.font = '700 50px "IBM Plex Mono", ui-monospace, monospace'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(text, 32, 36)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false })
  }

  /** Safety fencing behind and beside the cell, with light-curtain posts at the open front. */
  private buildGuarding(): void {
    const post = new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.6, metalness: 0.2 })
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 32
    const context = canvas.getContext('2d')!
    context.strokeStyle = '#59636e'
    context.lineWidth = 3
    context.strokeRect(0, 0, 32, 32)
    const mesh = new THREE.CanvasTexture(canvas)
    mesh.wrapS = mesh.wrapT = THREE.RepeatWrapping
    mesh.colorSpace = THREE.SRGBColorSpace
    const height = 2.2
    const panel = (x: number, z: number, length: number, turned: boolean) => {
      const texture = mesh.clone()
      texture.repeat.set(length * 5, height * 5)
      texture.needsUpdate = true
      const plane = this.add(
        this.world,
        new THREE.PlaneGeometry(length, height - 0.3),
        new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.5, transparent: true, side: THREE.DoubleSide }),
        x,
        height / 2 + 0.1,
        z,
      )
      if (turned) plane.rotation.y = Math.PI / 2
      this.add(this.world, new THREE.BoxGeometry(turned ? 0.06 : length, 0.06, turned ? length : 0.06), post, x, height + 0.02, z)
    }
    const back = -5
    const left = -5.4
    const right = 5.4
    for (const x of [left, -1.8, 1.8, right]) this.add(this.world, new THREE.BoxGeometry(0.1, height, 0.1), post, x, height / 2, back)
    panel((left - 1.8) / 2, back, 3.6, false)
    panel(0, back, 3.6, false)
    panel((right + 1.8) / 2, back, 3.6, false)
    for (const x of [left, right]) {
      for (const z of [-1.6, 0.4]) this.add(this.world, new THREE.BoxGeometry(0.1, height, 0.1), post, x, height / 2, z)
      panel(x, (back - 1.6) / 2, 3.4, true)
      panel(x, -0.6, 2, true)
    }
    // Light curtain: a pair of posts either side of the operator's opening.
    const curtain = new THREE.MeshStandardMaterial({ color: 0x1a1206, emissive: palette.amber, emissiveIntensity: 1.6 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x12161a, roughness: 0.6 })
    for (const x of [2.2, 5.4]) {
      this.add(this.world, new THREE.BoxGeometry(0.16, 1.9, 0.16), dark, x, 0.95, 4.9)
      this.add(this.world, new THREE.BoxGeometry(0.04, 1.6, 0.04), curtain, x + (x < 3 ? 0.09 : -0.09), 1, 4.9)
    }
  }

  /** Controller cabinet with its screen, stack light and a teach pendant on a hook. */
  private buildCabinet(): void {
    const shell = new THREE.MeshStandardMaterial({ color: 0x4d5863, metalness: 0.4, roughness: 0.55 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x12161a, roughness: 0.7 })
    const x = 4.4
    const z = -3.6
    this.add(this.world, new THREE.BoxGeometry(1.5, 2.1, 0.9), shell, x, 1.05, z)
    this.add(this.world, new THREE.BoxGeometry(1.3, 0.04, 0.02), dark, x, 0.9, z + 0.46)
    for (let i = 0; i < 6; i++) this.add(this.world, new THREE.BoxGeometry(1.1, 0.03, 0.03), dark, x, 0.25 + i * 0.09, z + 0.46)
    // Emergency stop and key switch.
    const stop = new THREE.CylinderGeometry(0.09, 0.09, 0.08, 14)
    stop.rotateX(Math.PI / 2)
    this.add(this.world, stop, new THREE.MeshStandardMaterial({ color: palette.red, roughness: 0.5 }), x + 0.5, 1.15, z + 0.48)
    this.add(this.world, new THREE.BoxGeometry(0.26, 0.26, 0.02), new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.7 }), x + 0.5, 1.15, z + 0.455)

    // Screen showing the program's state.
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 160
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    this.hmi = { texture, context: canvas.getContext('2d')! }
    this.add(this.world, new THREE.BoxGeometry(1.06, 0.7, 0.04), dark, x - 0.12, 1.6, z + 0.46)
    this.add(this.world, new THREE.PlaneGeometry(0.98, 0.62), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }), x - 0.12, 1.6, z + 0.485)
    this.drawHmi()

    // Stack light.
    this.add(this.world, new THREE.CylinderGeometry(0.035, 0.035, 0.4, 8), dark, x + 0.5, 2.3, z)
    ;[palette.red, palette.amber, palette.green].forEach((color, i) => {
      const lamp = new THREE.MeshStandardMaterial({ color: 0x0b0d10, emissive: color, emissiveIntensity: 0.05 })
      this.add(this.world, new THREE.CylinderGeometry(0.09, 0.09, 0.16, 12), lamp, x + 0.5, 2.92 - i * 0.17, z)
      this.stack.push(lamp)
    })

    // Teach pendant hanging on the side, with its cable.
    this.add(this.world, new THREE.BoxGeometry(0.06, 0.46, 0.34), dark, x - 0.79, 1.3, z + 0.1)
    this.add(this.world, new THREE.BoxGeometry(0.02, 0.24, 0.24), new THREE.MeshStandardMaterial({ color: 0x06140f, emissive: palette.cyan, emissiveIntensity: 0.9 }), x - 0.825, 1.36, z + 0.1)
    const cable = new THREE.CatmullRomCurve3([
      new THREE.Vector3(x - 0.79, 1.08, z + 0.1),
      new THREE.Vector3(x - 0.95, 0.5, z + 0.2),
      new THREE.Vector3(x - 0.8, 0.2, z + 0.3),
      new THREE.Vector3(x - 0.74, 0.3, z + 0.1),
    ])
    this.add(this.world, new THREE.TubeGeometry(cable, 20, 0.02, 6), dark, 0, 0, 0)
    // Cable duct along the floor from the cabinet to the robot.
    this.add(this.world, new THREE.BoxGeometry(0.22, 0.06, 3.6), new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.8 }), 0.9, 0.03, -1.9).rotation.y = -0.86
  }

  private drawHmi(): void {
    if (!this.hmi) return
    const { context: g, texture } = this.hmi
    const { logic } = this
    g.fillStyle = '#070a0d'
    g.fillRect(0, 0, 256, 160)
    g.font = '600 15px "IBM Plex Mono", ui-monospace, monospace'
    g.fillStyle = logic.phase === 'manual' ? '#ffb020' : '#5fd38d'
    g.fillText(phaseLabel[logic.phase], 10, 22)
    // One bar per joint: where it is within ±180°.
    logic.joints.forEach((angle, j) => {
      const y = 44 + j * 24
      g.fillStyle = '#7a8591'
      g.font = '500 12px "IBM Plex Mono", ui-monospace, monospace'
      g.fillText(`J${j + 1}`, 10, y + 10)
      g.fillStyle = '#1d252e'
      g.fillRect(40, y, 150, 12)
      const wrapped = Math.atan2(Math.sin(angle), Math.cos(angle))
      g.fillStyle = '#4cc9f0'
      g.fillRect(40 + 75 + (wrapped / Math.PI) * 75 - 2, y, 4, 12)
      g.fillStyle = '#c3cbd4'
      g.fillText(`${Math.round((wrapped * 180) / Math.PI)}°`, 198, y + 10)
    })
    g.fillStyle = '#7a8591'
    g.fillText(`CYCLE ${logic.lastCycle > 0 ? logic.lastCycle.toFixed(1) + ' s' : '--'}   DONE ${logic.placed}`, 10, 150)
    texture.needsUpdate = true
  }

  /** The arm: a chain of nested groups, one per joint, so each joint is a single rotation. */
  private buildArm(): void {
    const paint = new THREE.MeshPhysicalMaterial({ color: 0xff8a1f, metalness: 0.35, roughness: 0.4, clearcoat: 0.6, clearcoatRoughness: 0.3 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b2026, metalness: 0.5, roughness: 0.5 })
    const steel = new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.8, roughness: 0.3 })
    const across = (radius: number, length: number, segments = 20) => {
      const geometry = new THREE.CylinderGeometry(radius, radius, length, segments)
      geometry.rotateX(Math.PI / 2)
      return geometry
    }
    const along = (radius: number, length: number) => {
      const geometry = new THREE.CylinderGeometry(radius, radius, length, 16)
      geometry.rotateZ(Math.PI / 2)
      return geometry
    }

    // Pedestal, bolted to the floor.
    const pedestalHeight = 0.5
    const pedestal = new THREE.Group()
    this.add(pedestal, new THREE.CylinderGeometry(0.62, 0.72, pedestalHeight, 28), dark, 0, pedestalHeight / 2, 0)
    this.add(pedestal, new THREE.CylinderGeometry(0.86, 0.86, 0.06, 28), steel, 0, 0.03, 0)
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2
      this.add(pedestal, new THREE.CylinderGeometry(0.045, 0.045, 0.05, 6), dark, Math.cos(angle) * 0.76, 0.08, Math.sin(angle) * 0.76)
    }
    mergeStaticMeshes(pedestal)
    this.baseRing = new THREE.MeshStandardMaterial({ color: 0x0b1a1f, emissive: palette.cyan, emissiveIntensity: 0.5 })
    this.add(pedestal, new THREE.CylinderGeometry(0.64, 0.64, 0.04, 28, 1, true), this.baseRing, 0, pedestalHeight - 0.03, 0)
    this.world.add(pedestal)

    // Joint 1: the turret turns about the vertical axis.
    this.yaw = new THREE.Group()
    this.yaw.position.y = pedestalHeight
    this.world.add(this.yaw)
    const shoulderY = ARM.shoulderHeight - pedestalHeight
    this.add(this.yaw, new THREE.CylinderGeometry(0.52, 0.58, 0.34, 24), paint, 0, 0.17, 0)
    this.add(this.yaw, new THREE.BoxGeometry(0.5, shoulderY, 0.16), paint, -0.05, shoulderY / 2 + 0.1, 0.36)
    this.add(this.yaw, new THREE.BoxGeometry(0.5, shoulderY, 0.16), paint, -0.05, shoulderY / 2 + 0.1, -0.36)
    this.add(this.yaw, new THREE.BoxGeometry(0.46, 0.4, 0.5), dark, -0.5, 0.45, 0)
    this.add(this.yaw, across(0.3, 1.02), dark, 0, shoulderY, 0)
    this.add(this.yaw, across(0.2, 0.22), steel, 0, shoulderY, 0.6)

    // Joint 2: the shoulder lifts the upper arm.
    this.shoulder = new THREE.Group()
    this.shoulder.position.y = shoulderY
    this.yaw.add(this.shoulder)
    this.add(this.shoulder, new THREE.BoxGeometry(ARM.upper, 0.36, 0.4), paint, ARM.upper / 2, 0, 0)
    this.add(this.shoulder, new THREE.BoxGeometry(ARM.upper * 0.62, 0.2, 0.46), dark, ARM.upper * 0.5, 0, 0)
    this.add(this.shoulder, new THREE.BoxGeometry(0.6, 0.46, 0.5), dark, -0.42, 0, 0)
    this.add(this.shoulder, along(0.035, ARM.upper * 0.8), dark, ARM.upper * 0.5, 0.22, 0.14)
    this.add(this.shoulder, across(0.27, 0.74), dark, ARM.upper, 0, 0)

    // Joint 3: the elbow.
    this.elbow = new THREE.Group()
    this.elbow.position.x = ARM.upper
    this.shoulder.add(this.elbow)
    this.add(this.elbow, new THREE.BoxGeometry(ARM.fore, 0.26, 0.3), paint, ARM.fore / 2, 0, 0)
    this.add(this.elbow, new THREE.BoxGeometry(0.7, 0.34, 0.36), paint, 0.3, 0, 0)
    this.add(this.elbow, new THREE.BoxGeometry(0.5, 0.3, 0.34), dark, -0.36, 0, 0)
    this.add(this.elbow, along(0.03, ARM.fore * 0.7), dark, ARM.fore * 0.5, 0.16, -0.1)
    this.add(this.elbow, across(0.19, 0.5), dark, ARM.fore, 0, 0)

    // Joint 4: the wrist keeps the tool vertical.
    this.wrist = new THREE.Group()
    this.wrist.position.x = ARM.fore
    this.elbow.add(this.wrist)
    this.add(this.wrist, along(0.14, 0.26), paint, 0.14, 0, 0)
    this.add(this.wrist, along(0.17, 0.05), steel, 0.28, 0, 0)

    // Tool: the gripper turns about the tool axis, then two jaws slide apart.
    this.roll = new THREE.Group()
    this.roll.position.x = 0.3
    this.wrist.add(this.roll)
    const tip = ARM.tool - 0.3
    this.add(this.roll, new THREE.BoxGeometry(tip - 0.1, 0.22, 0.22), dark, (tip - 0.1) / 2, 0, 0)
    this.add(this.roll, new THREE.BoxGeometry(0.1, 0.3, 1), steel, tip - 0.05, 0, 0)
    for (let i = 0; i < 2; i++) {
      const finger = this.add(this.roll, new THREE.BoxGeometry(0.42, 0.26, 0.05), steel, tip + 0.16, 0, 0)
      this.add(finger, new THREE.BoxGeometry(0.3, 0.2, 0.02), dark, 0.04, 0, i === 0 ? -0.03 : 0.03)
      this.fingers.push(finger)
    }
  }

  /** Parts, the tip trace, the reach envelope and the manual target marker. */
  private buildOverlays(): void {
    this.partMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(PART_SIZE, PART_HEIGHT, PART_SIZE),
      new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.1 }),
      MAX_PARTS,
    )
    this.partMesh.frustumCulled = false
    this.partMesh.count = 0
    this.partMesh.setColorAt(0, this.color.setHex(binColors[0]))
    this.partMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.world.add(this.partMesh)

    const traceGeometry = new THREE.BufferGeometry()
    traceGeometry.setAttribute('position', new THREE.BufferAttribute(this.tracePositions, 3))
    traceGeometry.setDrawRange(0, 0)
    this.trace = new THREE.Line(traceGeometry, new THREE.LineBasicMaterial({ color: palette.cyan, transparent: true, opacity: 0.75 }))
    this.trace.frustumCulled = false
    this.world.add(this.trace)

    // Working envelope: the farthest the wrist can reach, as arcs from the shoulder.
    this.envelope = new THREE.Group()
    const arcMaterial = new THREE.LineDashedMaterial({ color: 0x3f6f86, dashSize: 0.18, gapSize: 0.14, transparent: true, opacity: 0.8 })
    for (let k = 0; k < 6; k++) {
      const points: THREE.Vector3[] = []
      for (let i = 0; i <= 40; i++) {
        const angle = -0.3 + (i / 40) * (Math.PI / 2 + 0.3)
        points.push(new THREE.Vector3(Math.cos(angle) * REACH, ARM.shoulderHeight + Math.sin(angle) * REACH, 0))
      }
      const arc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), arcMaterial)
      arc.computeLineDistances()
      arc.rotation.y = (k / 6) * Math.PI * 2
      this.envelope.add(arc)
    }
    this.world.add(this.envelope)

    // Manual target: a ring at the requested point with a line dropped to the floor.
    this.marker = new THREE.Group()
    this.markerMaterial = new THREE.MeshBasicMaterial({ color: palette.cyan, toneMapped: false, depthTest: false })
    const ring = new THREE.TorusGeometry(0.28, 0.025, 6, 32)
    ring.rotateX(Math.PI / 2)
    const ringMesh = this.add(this.marker, ring, this.markerMaterial, 0, 0, 0)
    ringMesh.renderOrder = 5
    for (const turned of [false, true]) {
      const bar = this.add(this.marker, new THREE.BoxGeometry(0.8, 0.012, 0.012), this.markerMaterial, 0, 0, 0)
      bar.renderOrder = 5
      if (turned) bar.rotation.y = Math.PI / 2
    }
    const drop = new THREE.CylinderGeometry(0.008, 0.008, 1, 5)
    drop.translate(0, -0.5, 0)
    const dropMesh = this.add(this.marker, drop, this.markerMaterial, 0, 0, 0)
    dropMesh.scale.y = 4
    dropMesh.renderOrder = 5
    this.marker.visible = false
    this.world.add(this.marker)
  }

  /** Distance in pixels from the pointer to the target marker on screen. */
  private markerDistance(event: PointerEvent): number {
    const element = this.ctx.element!
    const rect = element.getBoundingClientRect()
    this.projected.set(this.target[0], this.target[1] - DROP, this.target[2]).project(this.camera)
    const x = rect.left + ((this.projected.x + 1) / 2) * rect.width
    const y = rect.top + ((1 - this.projected.y) / 2) * rect.height
    return Math.hypot(event.clientX - x, event.clientY - y)
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (this.logic.phase !== 'manual' || event.button !== 0 || event.altKey || !this.ctx.element) return
    // Only a press on the marker moves the target; anywhere else still orbits the camera.
    if (this.markerDistance(event) > GRAB_RADIUS) return
    event.stopImmediatePropagation()
    event.preventDefault()
    this.dragging = event.pointerId
    this.ctx.element.setPointerCapture(event.pointerId)
  }

  private onPointerMove = (event: PointerEvent): void => {
    const element = this.ctx.element
    if (!element) return
    if (this.dragging !== event.pointerId) {
      if (this.logic.phase === 'manual' && event.pointerType === 'mouse' && event.buttons === 0) {
        element.style.cursor = this.markerDistance(event) <= GRAB_RADIUS ? 'grab' : ''
      }
      return
    }
    event.stopImmediatePropagation()
    // Slide the target across the horizontal plane at its current height.
    const rect = element.getBoundingClientRect()
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    this.plane.constant = -(this.target[1] - DROP)
    if (!this.raycaster.ray.intersectPlane(this.plane, this.hit)) return
    const radius = Math.hypot(this.hit.x, this.hit.z)
    const limit = Math.min(1, 5.4 / Math.max(radius, 1e-6))
    this.target = [this.hit.x * limit, this.target[1], this.hit.z * limit]
    this.logic.params = this.readParams()
  }

  private onPointerUp = (event: PointerEvent): void => {
    if (this.dragging !== event.pointerId) return
    event.stopImmediatePropagation()
    this.dragging = null
  }
}
