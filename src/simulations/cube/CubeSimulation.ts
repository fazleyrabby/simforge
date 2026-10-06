import * as THREE from 'three'
import { makeIsoCamera } from '../../three/cameras'
import { mergeStaticMeshes } from '../../three/merge'
import { palette } from '../../three/palette'
import { makePlinth } from '../../three/plinth'
import { BaseSimulation } from '../core/BaseSimulation'
import type { ParamValue, StatValue } from '../core/Simulation'
import { CubeLogic, PHASES, type Move } from './CubeLogic'

/** Edge length of the whole cube, whatever its size, and where its center sits. */
const SIDE = 4.4
const HALF = SIDE / 2
const CENTER_Y = 4.5
/** How far a hand's palm sits off its face when idle, and how far its fingers stand out from the cube's sides. */
const REST = 0.9
const OPEN = 0.3
/** Distance from the cube's center to each motor. */
const MOUNT = 4.2
/** Sticker colours by face: +x red, −x orange, +y white, −y yellow, +z green, −z blue. */
const STICKERS = [0xc4161c, 0xf2640c, 0xe6e6e0, 0xf5c400, 0x129a45, 0x1550c8]
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]
const PHASE_LABELS = { parity: 'Parity', centres: 'Centres', edges: 'Edges', corners: 'Corners' }

/** One of the six spindles that turn the cube. */
interface Actuator {
  /** Slides along the axis toward the face. */
  slide: THREE.Group
  /** Spins with the layer being turned. */
  clamp: THREE.Group
  /** Four fingers that reach down the cube's sides to the layer being turned. */
  fingers: { group: THREE.Group; bar: THREE.Mesh; pad: THREE.Mesh; angle: number }[]
  /** 0 open and backed off, 1 closed on the cube. */
  extension: number
  /** How far the fingers reach past the palm. */
  reach: number
}

export default class CubeSimulation extends BaseSimulation {
  private logic!: CubeLogic
  private size = 3
  private cell = SIDE / 3
  private stickers!: THREE.InstancedMesh
  private bodies!: THREE.InstancedMesh
  /** Layer of each body cell along each axis, and its resting position. */
  private bodyCells: number[][] = []
  private stickerBase: THREE.Matrix4[] = []
  private bodyBase: THREE.Matrix4[] = []
  private cube = new THREE.Group()
  private band!: THREE.Group
  private actuators: Actuator[] = []
  private lamps: THREE.MeshStandardMaterial[] = []
  private pulse = 0
  private padLength = 0.5
  private waited = 0
  private byHand = false

  private dragging: { pointer: number; point: THREE.Vector3; normal: number; sign: number; spent: boolean } | null = null
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private box = new THREE.Box3(new THREE.Vector3(-HALF, CENTER_Y - HALF, -HALF), new THREE.Vector3(HALF, CENTER_Y + HALF, HALF))
  private plane = new THREE.Plane()
  private hit = new THREE.Vector3()
  private matrix = new THREE.Matrix4()
  private turn = new THREE.Matrix4()
  private color = new THREE.Color()

  constructor() {
    super(makeIsoCamera(new THREE.Vector3(1, 0.72, 1)))
    this.params = { size: 3, speed: 6, autoRun: true }
  }

  protected build(): void {
    this.actuators = []
    this.lamps = []
    this.bodyCells = []
    this.stickerBase = []
    this.bodyBase = []
    this.pulse = 0
    this.waited = 0
    this.byHand = false
    this.dragging = null
    this.size = Math.round(this.num('size'))
    this.cell = SIDE / this.size

    this.logic = new CubeLogic(this.size, this.rng)
    this.logic.speed = this.num('speed')
    this.logic.onSolved = () => {
      this.pulse = 1
      this.events.emit({
        type: 'cube_solved',
        level: 'info',
        title: 'SOLVED',
        message: `${this.size}×${this.size}×${this.size} in ${this.logic.total} turns, ${this.logic.solveTime.toFixed(1)} s.`,
      })
    }

    this.world.add(makePlinth(12.4, 12.4))
    this.buildRig()
    this.buildCube()
    this.enableShadows(this.world)
    this.lighting.setShadowExtent(12)
    // The scene is lowered so the cube, not the floor, sits at the middle of the view.
    this.world.position.y = -(CENTER_Y - 0.6)
    this.box.min.set(-HALF, 0.6 - HALF, -HALF)
    this.box.max.set(HALF, 0.6 + HALF, HALF)
    this.setView(this.isPreview ? 8.4 : 9.4, this.isPreview ? 6.9 : 7.7)

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
  }

  protected update(dt: number): void {
    const { logic } = this
    logic.step(dt)
    this.pulse = Math.max(0, this.pulse - dt * 1.4)

    // Left alone, the machine scrambles a solved cube and solves a scrambled one.
    if (logic.busy || this.dragging) {
      this.waited = 0
    } else if (this.isPreview || this.bool('autoRun')) {
      this.waited += dt
      if (logic.status === 'solved' && this.waited > 2.4) {
        this.byHand = false
        logic.scramble()
      } else if (logic.status === 'idle' && this.waited > (this.byHand ? 3 : 0.8)) {
        this.byHand = false
        logic.solve()
      }
    }

    // Clamps close on the side nearest the layer being turned.
    const move = logic.current
    const active = move ? move.axis * 2 + (move.layer * 2 < this.size - 1 ? 1 : 0) : -1
    const rate = Math.min(1, dt * Math.max(10, logic.rate * 3))
    this.actuators.forEach((actuator, i) => {
      actuator.extension += ((i === active ? 1 : 0) - actuator.extension) * rate
      // Fingers reach to the middle of the layer being turned, counted from this hand's side.
      const depth = move ? (i % 2 === 0 ? this.size - 1 - move.layer : move.layer) : 0
      const reach = i === active ? (depth + 0.5) * this.cell + 0.1 : 0.45
      actuator.reach += (reach - actuator.reach) * rate
    })
  }

  render(_alpha: number): void {
    const { logic, size } = this
    const move = logic.current
    let angle = 0
    if (move) {
      // Slow turns ease in and out; fast ones are a blur either way.
      const p = logic.progress
      const eased = logic.rate < 14 ? p * p * (3 - 2 * p) : p
      angle = eased * (move.turns === 3 ? -1 : move.turns) * (Math.PI / 2)
      this.turn.makeRotationAxis(AXES[move.axis], angle)
    }

    const colors = logic.cube.colors
    for (let i = 0; i < this.stickerBase.length; i++) {
      if (move && logic.cube.layerOf(i, move.axis) === move.layer) this.matrix.multiplyMatrices(this.turn, this.stickerBase[i])
      else this.matrix.copy(this.stickerBase[i])
      this.stickers.setMatrixAt(i, this.matrix)
      this.stickers.setColorAt(i, this.color.setHex(STICKERS[colors[i]]))
    }
    this.stickers.instanceMatrix.needsUpdate = true
    this.stickers.instanceColor!.needsUpdate = true
    for (let i = 0; i < this.bodyBase.length; i++) {
      if (move && this.bodyCells[i][move.axis] === move.layer) this.matrix.multiplyMatrices(this.turn, this.bodyBase[i])
      else this.matrix.copy(this.bodyBase[i])
      this.bodies.setMatrixAt(i, this.matrix)
    }
    this.bodies.instanceMatrix.needsUpdate = true

    // A lit band marks the layer in motion.
    this.band.visible = move !== null
    if (move) {
      this.band.quaternion.setFromUnitVectors(AXES[1], AXES[move.axis])
      this.band.rotateY(angle)
      this.band.position.copy(AXES[move.axis]).multiplyScalar((move.layer - (size - 1) / 2) * this.cell)
    }

    const scale = 1 + Math.sin(this.pulse * Math.PI) * 0.05
    this.cube.scale.setScalar(scale)

    this.actuators.forEach((actuator, i) => {
      actuator.slide.position.z = -REST * (1 - actuator.extension)
      const radius = HALF + 0.11 + OPEN * (1 - actuator.extension)
      for (const finger of actuator.fingers) {
        finger.group.position.set(Math.cos(finger.angle) * radius, Math.sin(finger.angle) * radius, 0)
        finger.bar.scale.z = actuator.reach
        finger.pad.position.z = actuator.reach - 0.1 - this.padLength / 2
      }
      // A clamp looks along its shaft toward the cube, so the two sides of an axis spin opposite ways.
      const sign = i % 2 === 0 ? -1 : 1
      if (move && move.axis * 2 + (move.layer * 2 < size - 1 ? 1 : 0) === i) actuator.clamp.rotation.z = angle * sign
    })

    const at = logic.phase ? PHASES.indexOf(logic.phase) : -1
    const blink = Math.sin(this.time * 10) > 0 ? 1 : 0.3
    this.lamps.forEach((lamp, i) => {
      const done = logic.status === 'solved' || (logic.status === 'solving' && i < at)
      const live = logic.status === 'solving' && i === at
      lamp.emissive.setHex(done ? palette.green : palette.amber)
      lamp.emissiveIntensity = done ? 1.8 : live ? 2.2 * blink : 0.06
    })
  }

  protected onParam(key: string, value: ParamValue): void {
    if (key === 'size') this.rebuild()
    else if (key === 'speed') this.logic.speed = Number(value)
  }

  action(key: string): void {
    this.byHand = false
    this.waited = 0
    if (key === 'scramble') this.logic.scramble()
    else if (key === 'solve') this.logic.solve()
  }

  getStats(): Record<string, StatValue> {
    const { logic, size } = this
    const state = { idle: 'SCRAMBLED', scrambling: 'SCRAMBLING', solving: 'SOLVING', solved: 'SOLVED' }[logic.status]
    return {
      state,
      size: `${size}×${size}×${size}`,
      phase: logic.status === 'solving' && logic.phase ? PHASE_LABELS[logic.phase] : '—',
      moves: logic.total > 0 ? `${logic.done} / ${logic.total}` : '—',
      time: logic.total > 0 ? `${logic.solveTime.toFixed(1)} s` : '—',
      rate: logic.rate.toFixed(0),
      solves: logic.solves,
      pieces: size ** 3 - Math.max(size - 2, 0) ** 3,
    }
  }

  entityCount(): number {
    return this.bodyBase.length
  }

  private add(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(x, y, z)
    parent.add(mesh)
    return mesh
  }

  /** The cube: a dark body per piece and a coloured tile per sticker, both instanced. */
  private buildCube(): void {
    const { size, cell } = this
    const cube = this.logic.cube
    this.cube = new THREE.Group()
    this.cube.position.set(0, CENTER_Y, 0)
    this.world.add(this.cube)

    const offset = (index: number) => (index - (size - 1) / 2) * cell
    const cells: number[][] = []
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        for (let z = 0; z < size; z++) {
          if (Math.min(x, y, z) > 0 && Math.max(x, y, z) < size - 1) continue
          cells.push([x, y, z])
        }
      }
    }
    this.bodyCells = cells
    this.bodies = new THREE.InstancedMesh(new THREE.BoxGeometry(cell * 0.985, cell * 0.985, cell * 0.985), new THREE.MeshStandardMaterial({ color: 0x0c0e11, roughness: 0.6 }), cells.length)
    cells.forEach(([x, y, z], i) => {
      this.bodyBase.push(new THREE.Matrix4().makeTranslation(offset(x), offset(y), offset(z)))
      this.bodies.setMatrixAt(i, this.bodyBase[i])
    })
    this.cube.add(this.bodies)

    const tile = new THREE.BoxGeometry(cell * 0.88, cell * 0.88, cell * 0.04)
    this.stickers = new THREE.InstancedMesh(tile, new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 }), cube.count)
    const facing = new THREE.Quaternion()
    const scale = new THREE.Vector3(1, 1, 1)
    const position = new THREE.Vector3()
    const out = new THREE.Vector3()
    for (let i = 0; i < cube.count; i++) {
      const { x, y, z, face } = cube.facelet(i)
      out.copy(AXES[face >> 1]).multiplyScalar(face & 1 ? -1 : 1)
      facing.setFromUnitVectors(AXES[2], out)
      // Facelet positions are in half-cells; the coordinate along the normal is the surface.
      position.set(x, y, z).multiplyScalar(cell / 2).addScaledVector(out, cell * 0.012)
      this.stickerBase.push(new THREE.Matrix4().compose(position, facing, scale))
      this.stickers.setMatrixAt(i, this.stickerBase[i])
      this.stickers.setColorAt(i, this.color.setHex(STICKERS[face]))
    }
    this.cube.add(this.stickers)

    // Four bars around the layer in motion.
    this.band = new THREE.Group()
    const glow = new THREE.MeshBasicMaterial({ color: palette.cyan, toneMapped: false })
    const reach = HALF + 0.07
    for (let i = 0; i < 4; i++) {
      const bar = this.add(this.band, new THREE.BoxGeometry(reach * 2 + 0.05, cell * 0.14, 0.05), glow, 0, 0, 0)
      bar.rotation.y = (i * Math.PI) / 2
      bar.position.set(Math.sin((i * Math.PI) / 2) * reach, 0, Math.cos((i * Math.PI) / 2) * reach)
    }
    this.band.visible = false
    this.cube.add(this.band)
  }

  /** Six spindles on a frame, one facing each side of the cube, and a status panel. */
  private buildRig(): void {
    const steel = new THREE.MeshStandardMaterial({ color: palette.steel, metalness: 0.7, roughness: 0.35 })
    const dark = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.5, roughness: 0.5 })
    const light = new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.8, roughness: 0.25 })
    const amber = new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.55 })
    const rubber = new THREE.MeshStandardMaterial({ color: palette.rubber, roughness: 0.9 })
    const fixed = new THREE.Group()
    this.world.add(fixed)

    // Floor plate and hazard corners.
    this.add(fixed, new THREE.BoxGeometry(11.6, 0.12, 11.6), dark, 0, 0.06, 0)
    for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) this.add(fixed, new THREE.BoxGeometry(0.9, 0.02, 0.9), amber, x * 5.2, 0.13, z * 5.2)

    // A mast at the back corner carries the top spindle out over the cube.
    const mastHeight = CENTER_Y + MOUNT + 0.9
    this.add(fixed, new THREE.BoxGeometry(0.55, mastHeight, 0.55), steel, -4.6, mastHeight / 2, -4.6)
    this.add(fixed, new THREE.BoxGeometry(1.1, 0.3, 1.1), dark, -4.6, 0.27, -4.6)
    const boom = this.add(fixed, new THREE.BoxGeometry(6.9, 0.4, 0.4), steel, -2.3, mastHeight - 0.2, -2.3)
    boom.rotation.y = -Math.PI / 4
    const brace = this.add(fixed, new THREE.BoxGeometry(2.6, 0.16, 0.16), dark, -3.75, mastHeight - 1.1, -3.75)
    brace.rotation.set(0, -Math.PI / 4, 0)
    brace.rotateZ(-Math.PI / 4)

    // Stands for the four side spindles and a pedestal for the one underneath.
    const standOut = MOUNT
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      this.add(fixed, new THREE.BoxGeometry(0.5, CENTER_Y - 0.4, 0.5), steel, x * standOut, (CENTER_Y - 0.4) / 2 + 0.1, z * standOut)
      this.add(fixed, new THREE.BoxGeometry(1.2, 0.26, 1.2), dark, x * standOut, 0.25, z * standOut)
    }
    this.add(fixed, new THREE.CylinderGeometry(0.9, 1.15, 0.5, 24), dark, 0, 0.37, 0)

    // Each hand is built pointing along +z toward the cube, then turned to face its side.
    const shaftLength = MOUNT - HALF
    this.padLength = Math.min(this.cell * 0.8, 0.6)
    for (let i = 0; i < 6; i++) {
      const out = AXES[i >> 1].clone().multiplyScalar(i & 1 ? -1 : 1)
      const mount = new THREE.Group()
      mount.position.copy(out).multiplyScalar(MOUNT).setY(out.y * MOUNT + CENTER_Y)
      mount.quaternion.setFromUnitVectors(AXES[2], out.clone().negate())
      this.world.add(mount)
      // Motor housing with cooling fins.
      const motor = new THREE.CylinderGeometry(0.52, 0.52, 0.9, 20).rotateX(Math.PI / 2)
      this.add(mount, motor, dark, 0, 0, -0.1)
      for (let fin = 0; fin < 4; fin++) this.add(mount, new THREE.CylinderGeometry(0.58, 0.58, 0.05, 20).rotateX(Math.PI / 2), steel, 0, 0, -0.4 + fin * 0.2)
      this.add(mount, new THREE.CylinderGeometry(0.3, 0.3, 0.2, 16).rotateX(Math.PI / 2), amber, 0, 0, -0.62)

      const slide = new THREE.Group()
      mount.add(slide)
      const clamp = new THREE.Group()
      clamp.position.z = shaftLength
      slide.add(clamp)
      this.add(slide, new THREE.CylinderGeometry(0.13, 0.13, shaftLength, 12).rotateX(Math.PI / 2), light, 0, 0, shaftLength / 2 - 0.1)
      // Palm: a hub and a cross wide enough to carry a finger past each side of the cube.
      this.add(clamp, new THREE.CylinderGeometry(0.34, 0.34, 0.14, 20).rotateX(Math.PI / 2), steel, 0, 0, -0.12)
      for (let arm = 0; arm < 2; arm++) {
        const bar = this.add(clamp, new THREE.BoxGeometry((HALF + OPEN + 0.2) * 2, 0.14, 0.08), light, 0, 0, -0.1)
        bar.rotation.z = (arm * Math.PI) / 2
      }
      // Fingers slide in along the cross to grip, and lengthen to reach inner layers.
      const fingers: Actuator['fingers'] = []
      for (let k = 0; k < 4; k++) {
        const angle = (k * Math.PI) / 2
        const group = new THREE.Group()
        group.rotation.z = angle
        clamp.add(group)
        this.add(group, new THREE.BoxGeometry(0.3, 0.3, 0.16), steel, 0, 0, -0.1)
        const bar = this.add(group, new THREE.BoxGeometry(0.13, 0.2, 1).translate(0, 0, 0.5), light, 0.02, 0, -0.1)
        const pad = this.add(group, new THREE.BoxGeometry(0.1, Math.min(this.cell * 0.7, 0.5), this.padLength), amber, -0.07, 0, 0)
        fingers.push({ group, bar, pad, angle })
      }
      this.actuators.push({ slide, clamp, fingers, extension: 0, reach: 0.45 })
    }

    // Status panel: one lamp per phase of the solve.
    const panel = new THREE.Group()
    panel.position.set(4.9, 0.12, -3.1)
    panel.rotation.y = Math.PI / 4
    this.world.add(panel)
    this.add(panel, new THREE.BoxGeometry(2.6, 0.7, 0.5), dark, 0, 0.35, 0)
    const face = this.add(panel, new THREE.BoxGeometry(2.4, 0.5, 0.05), rubber, 0, 0.5, 0.2)
    face.rotation.x = -0.5
    PHASES.forEach((_, i) => {
      const lamp = new THREE.MeshStandardMaterial({ color: 0x0b0d10, emissive: palette.amber, emissiveIntensity: 0.06 })
      const bulb = this.add(panel, new THREE.CylinderGeometry(0.15, 0.15, 0.08, 16).rotateX(Math.PI / 2), lamp, -0.84 + i * 0.56, 0.52, 0.24)
      bulb.rotation.x = -0.5
      this.lamps.push(lamp)
    })

    mergeStaticMeshes(fixed)
  }

  /** Where a ray from the pointer meets the cube, and which face it meets. */
  private pick(event: PointerEvent): { point: THREE.Vector3; normal: number; sign: number } | null {
    this.aim(event)
    const point = this.raycaster.ray.intersectBox(this.box, this.hit)
    if (!point) return null
    const local = [point.x - (this.box.min.x + HALF), point.y - (this.box.min.y + HALF), point.z - (this.box.min.z + HALF)]
    const normal = local.reduce((best, value, axis) => (Math.abs(value) > Math.abs(local[best]) ? axis : best), 0)
    return { point: new THREE.Vector3(...local), normal, sign: Math.sign(local[normal]) }
  }

  private aim(event: PointerEvent): void {
    const rect = this.ctx.element!.getBoundingClientRect()
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || event.altKey || !this.ctx.element) return
    if (this.logic.status === 'scrambling' || this.logic.status === 'solving') return
    // Only a press on the cube is claimed; anywhere else still moves the camera.
    const picked = this.pick(event)
    if (!picked) return
    event.stopImmediatePropagation()
    event.preventDefault()
    this.ctx.element.setPointerCapture(event.pointerId)
    this.dragging = { pointer: event.pointerId, ...picked, spent: false }
  }

  private onPointerMove = (event: PointerEvent): void => {
    const drag = this.dragging
    if (!drag || drag.pointer !== event.pointerId) return
    event.stopImmediatePropagation()
    if (drag.spent) return
    // Follow the pointer across the plane of the face that was pressed.
    this.aim(event)
    const center = [this.box.min.x + HALF, this.box.min.y + HALF, this.box.min.z + HALF]
    this.plane.normal.copy(AXES[drag.normal]).multiplyScalar(drag.sign)
    this.plane.constant = -(drag.sign * (center[drag.normal] + drag.sign * HALF))
    if (!this.raycaster.ray.intersectPlane(this.plane, this.hit)) return
    const delta = [this.hit.x - center[0] - drag.point.x, this.hit.y - center[1] - drag.point.y, this.hit.z - center[2] - drag.point.z]
    const along = [0, 1, 2].filter((axis) => axis !== drag.normal).sort((a, b) => Math.abs(delta[b]) - Math.abs(delta[a]))[0]
    if (Math.abs(delta[along]) < Math.max(this.cell * 0.4, 0.3)) return

    // The layer turns about the remaining axis, in whichever sense carries the pressed sticker along the drag.
    const axis = (3 - drag.normal - along) as 0 | 1 | 2
    const handed = (drag.normal - axis + 3) % 3 === 1 ? 1 : -1
    const sense = Math.sign(delta[along]) * drag.sign * handed
    const layer = Math.min(this.size - 1, Math.max(0, Math.floor((drag.point.getComponent(axis) + HALF) / this.cell)))
    const move: Move = { axis, layer, turns: sense > 0 ? 1 : 3 }
    if (this.logic.turn(move)) {
      this.byHand = true
      this.waited = 0
    }
    drag.spent = true
  }

  private onPointerUp = (event: PointerEvent): void => {
    if (this.dragging?.pointer !== event.pointerId) return
    event.stopImmediatePropagation()
    this.dragging = null
  }
}
