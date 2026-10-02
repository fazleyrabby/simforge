import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { makeIsoCamera } from '../../three/cameras'
import { mergeStaticMeshes } from '../../three/merge'
import { palette } from '../../three/palette'
import { makePlinth } from '../../three/plinth'
import { BaseSimulation } from '../core/BaseSimulation'
import { Rng } from '../core/random'
import type { ParamValue, StatValue } from '../core/Simulation'
import { EAST, NORTH, SOUTH, WarehouseLogic, generateLayout, type Layout, type Robot, type RobotState } from './WarehouseLogic'

const CELL = 1.2
// Racking is kept low so robots in the aisles stay visible from the camera.
const SHELF_HEIGHT = 1.3
const LEVELS = [0.19, 0.77]
const SURGE_ORDERS = 20
const MAX_MARKERS = 90
const MAX_OUTBOUND = 14
const PATH_POINTS = 96

const toteColors = [0x2f8f8a, 0xe07a3f, 0x3a86ff, 0xc77dff, 0x5fd38d, 0xffb020]
const cartonColors = [0xc8975a, 0xb5834a, 0xd9b27c, 0xa97c50, 0x8d99a6, 0x2f8f8a, 0xb5483f]

const stateColor: Record<RobotState, THREE.Color> = {
  idle: new THREE.Color(palette.green),
  toPick: new THREE.Color(palette.cyan),
  loading: new THREE.Color(palette.amber),
  toStation: new THREE.Color(palette.cyan),
  unloading: new THREE.Color(palette.amber),
  toDock: new THREE.Color(0x8ea3ba),
  charging: new THREE.Color(0x3a86ff),
}
const stateLabel: Record<RobotState, string> = {
  idle: 'IDLE',
  toPick: 'TO SHELF',
  loading: 'LOADING',
  toStation: 'TO STATION',
  unloading: 'UNLOADING',
  toDock: 'RETURNING',
  charging: 'CHARGING',
}
const waitingColor = new THREE.Color(palette.red)
const markerColor = new THREE.Color(palette.amber)
const rushColor = new THREE.Color(palette.red)

/** Rendering-side counterpart of one robot. */
interface RobotVisual {
  robot: Robot
  root: THREE.Group
  led: THREE.MeshStandardMaterial
  tote: THREE.Mesh
  toteMaterial: THREE.MeshStandardMaterial
  lidar: THREE.Mesh
  /** Smoothed heading and tote size, so turns and loading are not instant. */
  heading: number
  load: number
}

export default class WarehouseSimulation extends BaseSimulation {
  private logic!: WarehouseLogic
  private layout!: Layout
  /** Randomness for appearance only; never feeds the simulation. */
  private fx = new Rng(1)
  private visuals: RobotVisual[] = []
  private selected = -1

  private racks!: THREE.InstancedMesh
  /** Shelf cell held by each rack instance. */
  private rackCells: number[] = []
  private cartons!: THREE.InstancedMesh
  /** Instance index of the aisle-side carton on each shelf, and when it comes back. */
  private frontCarton = new Map<number, number>()
  private restock = new Map<number, number>()
  private cartonMatrices: THREE.Matrix4[] = []

  private markers!: THREE.InstancedMesh
  private outbound!: THREE.InstancedMesh
  private outboundState: { x: number; z: number; age: number; color: number }[] = []
  private dockLamps = new Map<number, THREE.MeshStandardMaterial>()
  private stationLamps = new Map<number, { material: THREE.MeshStandardMaterial; flash: number }>()
  private pathLine!: THREE.Line
  private pathPositions = new Float32Array(PATH_POINTS * 3)
  private selectRing!: THREE.Mesh
  private targetRing!: THREE.Mesh

  private pointerStart: { x: number; y: number } | null = null
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private matrix = new THREE.Matrix4()
  private position = new THREE.Vector3()
  private scale = new THREE.Vector3()
  private quaternion = new THREE.Quaternion()
  private euler = new THREE.Euler()

  constructor() {
    super(makeIsoCamera(new THREE.Vector3(0.5, 1.3, 1)))
    this.params = { robots: 8, orderRate: 18, speed: 3 }
  }

  protected build(): void {
    this.visuals = []
    this.selected = -1
    this.frontCarton.clear()
    this.restock.clear()
    this.dockLamps.clear()
    this.stationLamps.clear()
    this.outboundState = []
    this.fx = new Rng(this.seed + 3)

    this.layout = this.isPreview ? generateLayout(this.rng, 4, 5, 2, 6) : generateLayout(this.rng, 8, 8, 3, 16)
    this.logic = new WarehouseLogic(this.rng, this.layout, this.num('robots'), this.readParams())
    this.logic.onPick = (order) => {
      // The aisle-side carton leaves the shelf with the robot and is restocked a little later.
      this.restock.set(order.shelf, this.time + 9)
      this.paintCarton(order.shelf, false)
    }
    this.logic.onComplete = (order, robot) => {
      const [x, z] = this.cellXZ(robot.cell)
      this.outboundState.push({ x, z: z + CELL * 0.7, age: 0, color: toteColors[order.id % toteColors.length] })
      if (this.outboundState.length > MAX_OUTBOUND) this.outboundState.shift()
      const lamp = this.stationLamps.get(robot.cell)
      if (lamp) lamp.flash = 1
      this.events.emit({ type: 'order_complete' })
    }

    const { width, height } = this.layout
    this.world.add(makePlinth(width * CELL + 3, height * CELL + 5.4))
    this.buildFloor()
    this.buildShelving()
    this.buildDocks()
    this.buildStations()
    mergeStaticMeshes(this.world)

    for (const robot of this.logic.robots) this.visuals.push(this.buildRobot(robot))
    this.buildOverlays()

    this.enableShadows(this.world)
    this.markers.castShadow = false
    this.lighting.setShadowExtent(width * CELL * 0.7 + 4)
    this.setView(width * CELL * 0.6 + 2.2, height * CELL * 0.6 + (this.isPreview ? 1.8 : 2.8))

    const element = this.ctx.element
    if (element && !this.isPreview) {
      element.addEventListener('pointerdown', this.onPointerDown)
      element.addEventListener('pointerup', this.onPointerUp)
      element.addEventListener('pointermove', this.onPointerMove)
    }
  }

  protected teardown(): void {
    const element = this.ctx?.element
    if (!element) return
    element.removeEventListener('pointerdown', this.onPointerDown)
    element.removeEventListener('pointerup', this.onPointerUp)
    element.removeEventListener('pointermove', this.onPointerMove)
    element.style.cursor = ''
  }

  protected update(dt: number): void {
    this.logic.step(dt)

    for (const visual of this.visuals) {
      const { robot } = visual
      // Turn toward the direction of travel by the shortest way round.
      let turn = -robot.heading - visual.heading
      turn = Math.atan2(Math.sin(turn), Math.cos(turn))
      visual.heading += turn * Math.min(1, dt * 12)
      const carrying = robot.state === 'toStation' || robot.state === 'loading' || robot.state === 'unloading'
      const target = robot.state === 'loading' ? 1 - robot.timer / 1.2 : robot.state === 'unloading' ? robot.timer / 1.2 : carrying ? 1 : 0
      visual.load += (THREE.MathUtils.clamp(target, 0, 1) - visual.load) * Math.min(1, dt * 14)
      visual.lidar.rotation.y += dt * 7
    }

    for (const [shelf, due] of this.restock) {
      if (this.time < due) continue
      this.restock.delete(shelf)
      this.paintCarton(shelf, true)
    }
    for (const tote of this.outboundState) tote.age += dt
    for (const lamp of this.stationLamps.values()) lamp.flash = Math.max(0, lamp.flash - dt * 1.6)
  }

  render(alpha: number): void {
    const blink = Math.sin(this.time * 10) > 0 ? 1 : 0.2
    for (const visual of this.visuals) {
      const { robot } = visual
      this.robotPosition(robot, alpha, visual.root.position)
      visual.root.rotation.y = visual.heading

      const waiting = robot.waiting > 0.4
      visual.led.emissive.copy(waiting ? waitingColor : stateColor[robot.state])
      visual.led.emissiveIntensity = waiting ? 2.4 * blink : robot.state === 'charging' ? 1 + Math.sin(this.time * 4) * 0.7 : 1.6

      visual.tote.visible = visual.load > 0.02
      visual.tote.scale.setScalar(Math.max(visual.load, 0.02))
      if (robot.order) visual.toteMaterial.color.setHex(toteColors[robot.order.id % toteColors.length])
    }

    for (const [cell, lamp] of this.dockLamps) {
      const occupant = this.logic.robots[this.logic.reserved[cell]]
      const charging = occupant !== undefined && occupant.cell === cell && occupant.battery < 0.99
      lamp.emissiveIntensity = charging ? 1.2 + Math.sin(this.time * 5) * 0.8 : 0.15
    }
    for (const lamp of this.stationLamps.values()) lamp.material.emissiveIntensity = 0.5 + lamp.flash * 3

    this.paintMarkers()
    this.paintOutbound()
    this.paintSelection(alpha)
  }

  protected onParam(key: string, _value: ParamValue): void {
    if (key === 'robots') this.rebuild()
    else this.logic.params = this.readParams()
  }

  action(key: string): void {
    if (key !== 'surge') return
    this.logic.surge(SURGE_ORDERS)
    this.events.emit({
      type: 'order_surge',
      level: 'info',
      title: 'ORDER SURGE',
      message: `${SURGE_ORDERS} orders arrived at once. Watch the queue and the aisles fill.`,
    })
  }

  getStats(): Record<string, StatValue> {
    const { logic } = this
    const stats: Record<string, StatValue> = {
      throughput: `${logic.throughput().toFixed(0)} / min`,
      queue: logic.queue.length,
      latency: `${logic.averageLatency().toFixed(1)} s`,
      busy: `${logic.busyRobots} / ${logic.robots.length}`,
      waiting: logic.waitingRobots,
      battery: (logic.averageBattery * 100).toFixed(0),
      completed: logic.completed,
    }
    const robot = logic.robots[this.selected]
    if (robot) {
      stats.selected = `BOT-${String(robot.id + 1).padStart(2, '0')} · ${robot.waiting > 0.4 ? 'QUEUED' : stateLabel[robot.state]}`
      stats.selBattery = (robot.battery * 100).toFixed(0)
      stats.selDistance = (robot.distance * CELL).toFixed(0)
    }
    return stats
  }

  entityCount(): number {
    return this.logic.robots.length + this.logic.openOrders
  }

  private readParams() {
    return { orderRate: this.num('orderRate'), speed: this.num('speed') }
  }

  /** World x, z of a cell's center. */
  private cellXZ(cell: number): [number, number] {
    const { width, height } = this.layout
    return [((cell % width) - (width - 1) / 2) * CELL, (Math.floor(cell / width) - (height - 1) / 2) * CELL]
  }

  private robotPosition(robot: Robot, alpha: number, target: THREE.Vector3): THREE.Vector3 {
    const [x, z] = this.cellXZ(robot.cell)
    if (robot.next < 0) return target.set(x, 0, z)
    const [nx, nz] = this.cellXZ(robot.next)
    const progress = Math.min(1, robot.prevProgress + (robot.progress - robot.prevProgress) * alpha)
    return target.set(x + (nx - x) * progress, 0, z + (nz - z) * progress)
  }

  private add(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(x, y, z)
    parent.add(mesh)
    return mesh
  }

  /** Floor markings: a direction arrow in every aisle cell and edge lines on the two lanes. */
  private buildFloor(): void {
    const { layout } = this
    const { width, height } = layout
    const spanX = width * CELL
    const spanZ = height * CELL

    this.add(
      this.world,
      new THREE.BoxGeometry(spanX + 0.5, 0.04, spanZ + 0.5),
      new THREE.MeshStandardMaterial({ color: 0x232a32, roughness: 0.85 }),
      0,
      0.02,
      0,
    )

    const arrowShape = new THREE.Shape()
    arrowShape.moveTo(0.22, 0)
    arrowShape.lineTo(-0.14, 0.16)
    arrowShape.lineTo(-0.06, 0)
    arrowShape.lineTo(-0.14, -0.16)
    arrowShape.closePath()
    const arrowGeometry = new THREE.ShapeGeometry(arrowShape)
    arrowGeometry.rotateX(-Math.PI / 2)
    const floorCells = layout.kinds.map((kind, cell) => (kind === 'floor' ? cell : -1)).filter((cell) => cell >= 0)
    const arrows = new THREE.InstancedMesh(arrowGeometry, new THREE.MeshBasicMaterial({ color: 0x4a5866 }), floorCells.length)
    floorCells.forEach((cell, i) => {
      const exits = layout.exits[cell]
      // A cell with two exits shows its through direction.
      const angle = exits & EAST ? 0 : exits & NORTH ? Math.PI / 2 : exits & SOUTH ? -Math.PI / 2 : Math.PI
      const [x, z] = this.cellXZ(cell)
      this.matrix.makeRotationY(angle).setPosition(x, 0.045, z)
      arrows.setMatrixAt(i, this.matrix)
    })
    this.world.add(arrows)

    const line = new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.8 })
    for (const row of [1, height - 2]) {
      const z = (row - (height - 1) / 2) * CELL
      for (const side of [-1, 1]) this.add(this.world, new THREE.BoxGeometry(spanX, 0.02, 0.06), line, 0, 0.05, z + side * CELL * 0.48)
    }

    // Low perimeter walls behind the docks and the stations.
    const wall = new THREE.MeshStandardMaterial({ color: 0x2c343d, roughness: 0.8, metalness: 0.2 })
    this.add(this.world, new THREE.BoxGeometry(spanX + 0.5, 1.1, 0.2), wall, 0, 0.55, -spanZ / 2 - 0.15)
    for (const side of [-1, 1]) this.add(this.world, new THREE.BoxGeometry(0.2, 1.1, spanZ + 0.5), wall, side * (spanX / 2 + 0.15), 0.55, 0)
  }

  /** Racking and its cartons, both instanced across every shelf cell. */
  private buildShelving(): void {
    const { layout } = this
    const size = CELL * 0.92
    const parts: THREE.BufferGeometry[] = []
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const post = new THREE.BoxGeometry(0.07, SHELF_HEIGHT, 0.07)
        post.translate(sx * (size / 2 - 0.035), SHELF_HEIGHT / 2, sz * (size / 2 - 0.035))
        parts.push(post)
      }
    }
    for (const y of [...LEVELS.map((level) => level - 0.04), SHELF_HEIGHT]) {
      const board = new THREE.BoxGeometry(size, 0.04, size)
      board.translate(0, y, 0)
      parts.push(board)
    }
    const rackGeometry = mergeGeometries(parts)!
    for (const part of parts) part.dispose()

    this.rackCells = layout.shelves
    this.racks = new THREE.InstancedMesh(
      rackGeometry,
      new THREE.MeshStandardMaterial({ color: 0x2b4f73, metalness: 0.45, roughness: 0.5 }),
      layout.shelves.length,
    )
    const perShelf = LEVELS.length * 2
    this.cartons = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ roughness: 0.85 }),
      layout.shelves.length * perShelf,
    )
    this.cartonMatrices = []
    const color = new THREE.Color()
    layout.shelves.forEach((shelf, s) => {
      const [x, z] = this.cellXZ(shelf)
      this.matrix.makeTranslation(x, 0.04, z)
      this.racks.setMatrixAt(s, this.matrix)
      // Which side of the cell faces the aisle a robot picks from.
      const side = Math.sign((layout.pickFace[shelf] % layout.width) - (shelf % layout.width))
      LEVELS.forEach((level, l) => {
        for (let k = 0; k < 2; k++) {
          const index = s * perShelf + l * 2 + k
          const w = this.fx.range(0.32, 0.44)
          const h = this.fx.range(0.24, 0.44)
          const d = this.fx.range(0.4, 0.8)
          this.position.set(x + (k === 0 ? side : -side) * size * 0.23, 0.04 + level + h / 2, z + this.fx.range(-0.08, 0.08))
          this.scale.set(w, h, d)
          const matrix = new THREE.Matrix4().compose(this.position, this.quaternion, this.scale)
          this.cartonMatrices[index] = matrix
          this.cartons.setMatrixAt(index, matrix)
          this.cartons.setColorAt(index, color.setHex(this.fx.pick(cartonColors)))
          if (l === 0 && k === 0) this.frontCarton.set(shelf, index)
        }
      })
    })
    this.world.add(this.racks, this.cartons)
  }

  /** Shows or hides the carton a robot takes from a shelf. */
  private paintCarton(shelf: number, present: boolean): void {
    const index = this.frontCarton.get(shelf)
    if (index === undefined) return
    if (present) this.matrix.copy(this.cartonMatrices[index])
    else this.matrix.makeScale(0, 0, 0)
    this.cartons.setMatrixAt(index, this.matrix)
    this.cartons.instanceMatrix.needsUpdate = true
  }

  /** Charging docks: a floor pad and a post whose lamp pulses while a robot charges. */
  private buildDocks(): void {
    const pad = new THREE.MeshStandardMaterial({ color: 0x10151b, roughness: 0.7 })
    const post = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.5, roughness: 0.5 })
    for (const dock of this.layout.docks) {
      const [x, z] = this.cellXZ(dock)
      this.add(this.world, new THREE.BoxGeometry(CELL * 0.86, 0.03, CELL * 0.86), pad, x, 0.055, z)
      this.add(this.world, new THREE.BoxGeometry(0.34, 0.8, 0.16), post, x, 0.44, z - CELL * 0.48)
      const lamp = new THREE.MeshStandardMaterial({ color: 0x06121f, emissive: 0x3a86ff, emissiveIntensity: 0.15 })
      this.add(this.world, new THREE.BoxGeometry(0.22, 0.42, 0.03), lamp, x, 0.5, z - CELL * 0.39)
      this.dockLamps.set(dock, lamp)
    }
  }

  /** Packing stations: a bench with a screen, and a conveyor carrying finished totes out. */
  private buildStations(): void {
    const steel = new THREE.MeshStandardMaterial({ color: palette.steel, metalness: 0.5, roughness: 0.45 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x12161b, roughness: 0.8 })
    const belt = new THREE.MeshStandardMaterial({ color: palette.rubber, roughness: 0.9 })
    const stripe = new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.7 })
    for (const station of this.layout.stations) {
      const [x, z] = this.cellXZ(station)
      this.add(this.world, new THREE.BoxGeometry(CELL * 0.92, 0.03, CELL * 0.92), stripe, x, 0.055, z)
      // Conveyor leading away from the floor.
      const start = z + CELL * 0.55
      this.add(this.world, new THREE.BoxGeometry(0.9, 0.5, 2.6), steel, x, 0.25, start + 1.3)
      this.add(this.world, new THREE.BoxGeometry(0.76, 0.04, 2.6), belt, x, 0.52, start + 1.3)
      for (const side of [-1, 1]) this.add(this.world, new THREE.BoxGeometry(0.05, 0.14, 2.6), steel, x + side * 0.43, 0.57, start + 1.3)
      // Bench and screen beside the conveyor.
      this.add(this.world, new THREE.BoxGeometry(0.9, 0.85, 0.6), steel, x + 1.05, 0.425, start + 0.5)
      this.add(this.world, new THREE.BoxGeometry(0.5, 0.36, 0.05), dark, x + 1.05, 1.14, start + 0.72)
      const lamp = new THREE.MeshStandardMaterial({ color: 0x06140f, emissive: palette.green, emissiveIntensity: 0.5 })
      this.add(this.world, new THREE.BoxGeometry(0.42, 0.28, 0.02), lamp, x + 1.05, 1.14, start + 0.69)
      this.add(this.world, new THREE.BoxGeometry(0.06, 0.2, 0.06), dark, x + 1.05, 0.95, start + 0.72)
      this.stationLamps.set(station, { material: lamp, flash: 0 })
    }
  }

  private buildRobot(robot: Robot): RobotVisual {
    const root = new THREE.Group()
    root.userData.robotId = robot.id
    this.world.add(root)
    const body = new THREE.MeshStandardMaterial({ color: 0xd9dde3, metalness: 0.35, roughness: 0.45 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x15191e, roughness: 0.7 })
    const plate = new THREE.MeshStandardMaterial({ color: palette.amber, metalness: 0.3, roughness: 0.5 })

    // Static parts, merged per material by the pass below. The robot faces +X.
    this.add(root, new THREE.BoxGeometry(0.82, 0.16, 0.7), body, 0, 0.2, 0)
    this.add(root, new THREE.BoxGeometry(0.9, 0.08, 0.78), dark, 0, 0.11, 0)
    this.add(root, new THREE.BoxGeometry(0.6, 0.04, 0.56), plate, -0.04, 0.3, 0)
    const wheel = new THREE.CylinderGeometry(0.11, 0.11, 0.08, 14)
    wheel.rotateX(Math.PI / 2)
    for (const side of [-1, 1]) this.add(root, wheel, dark, 0, 0.11, side * 0.38)
    this.add(root, new THREE.BoxGeometry(0.1, 0.05, 0.3), dark, 0.36, 0.3, 0)
    mergeStaticMeshes(root)

    const led = new THREE.MeshStandardMaterial({ color: 0x0b0d10, emissive: palette.green, emissiveIntensity: 1.6 })
    this.add(root, new THREE.BoxGeometry(0.03, 0.05, 0.5), led, 0.42, 0.2, 0)
    this.add(root, new THREE.BoxGeometry(0.03, 0.05, 0.5), led, -0.42, 0.2, 0)
    const lidar = this.add(root, new THREE.CylinderGeometry(0.07, 0.07, 0.07, 10), dark, 0.36, 0.36, 0)
    this.add(lidar, new THREE.BoxGeometry(0.03, 0.03, 0.12), led, 0, 0.02, 0)

    // A beacon on a mast, so the robot can be found among the racking.
    this.add(root, new THREE.CylinderGeometry(0.015, 0.015, 0.9, 6), dark, -0.36, 0.75, 0.28)
    this.add(root, new THREE.SphereGeometry(0.075, 10, 8), led, -0.36, 1.22, 0.28)

    const toteMaterial = new THREE.MeshStandardMaterial({ color: toteColors[0], roughness: 0.6 })
    const toteGeometry = new THREE.BoxGeometry(0.54, 0.34, 0.5)
    toteGeometry.translate(0, 0.17, 0)
    const tote = this.add(root, toteGeometry, toteMaterial, -0.04, 0.32, 0)
    tote.visible = false

    const visual: RobotVisual = { robot, root, led, tote, toteMaterial, lidar, heading: -robot.heading, load: 0 }
    this.robotPosition(robot, 0, root.position)
    root.rotation.y = visual.heading
    return visual
  }

  /** Markers for open orders, outbound totes, and the selected robot's route. */
  private buildOverlays(): void {
    this.markers = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.15, 0), new THREE.MeshBasicMaterial(), MAX_MARKERS)
    this.markers.frustumCulled = false
    this.markers.count = 0
    this.markers.setColorAt(0, markerColor)

    this.outbound = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.54, 0.34, 0.5),
      new THREE.MeshStandardMaterial({ roughness: 0.6 }),
      MAX_OUTBOUND,
    )
    this.outbound.frustumCulled = false
    this.outbound.count = 0
    this.outbound.setColorAt(0, markerColor)

    const pathGeometry = new THREE.BufferGeometry()
    pathGeometry.setAttribute('position', new THREE.BufferAttribute(this.pathPositions, 3))
    pathGeometry.setDrawRange(0, 0)
    this.pathLine = new THREE.Line(pathGeometry, new THREE.LineBasicMaterial({ color: palette.amber }))
    this.pathLine.frustumCulled = false

    const ring = new THREE.TorusGeometry(0.62, 0.025, 6, 32)
    ring.rotateX(Math.PI / 2)
    this.selectRing = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ color: palette.white }))
    this.targetRing = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ color: palette.amber }))
    this.selectRing.visible = false
    this.targetRing.visible = false
    this.world.add(this.markers, this.outbound, this.pathLine, this.selectRing, this.targetRing)
  }

  /** A bobbing marker over every shelf with an order waiting or a robot on its way. */
  private paintMarkers(): void {
    let count = 0
    const place = (shelf: number, rush: boolean) => {
      if (count >= MAX_MARKERS) return
      const [x, z] = this.cellXZ(shelf)
      this.euler.set(0, this.time * 2 + shelf, 0)
      this.quaternion.setFromEuler(this.euler)
      this.position.set(x, SHELF_HEIGHT + 0.45 + Math.sin(this.time * 3 + shelf) * 0.08, z)
      this.matrix.compose(this.position, this.quaternion, this.scale.setScalar(rush ? 1.4 : 1))
      this.markers.setMatrixAt(count, this.matrix)
      this.markers.setColorAt(count, rush ? rushColor : markerColor)
      count++
    }
    for (const order of this.logic.queue) place(order.shelf, order.rush)
    for (const robot of this.logic.robots) if (robot.order && robot.state === 'toPick') place(robot.order.shelf, robot.order.rush)
    this.quaternion.identity()
    this.markers.count = count
    this.markers.instanceMatrix.needsUpdate = true
    if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true
  }

  /** Finished totes ride the station conveyors out of the warehouse. */
  private paintOutbound(): void {
    const color = new THREE.Color()
    let count = 0
    for (const tote of this.outboundState) {
      const travel = tote.age * 0.9
      if (travel > 2.1) continue
      this.matrix.makeTranslation(tote.x, 0.71, tote.z + travel)
      this.outbound.setMatrixAt(count, this.matrix)
      this.outbound.setColorAt(count, color.setHex(tote.color))
      count++
    }
    this.outbound.count = count
    this.outbound.instanceMatrix.needsUpdate = true
    if (this.outbound.instanceColor) this.outbound.instanceColor.needsUpdate = true
  }

  /** Ring under the selected robot and a line along the route it has planned. */
  private paintSelection(alpha: number): void {
    const robot = this.logic.robots[this.selected]
    this.selectRing.visible = robot !== undefined
    const geometry = this.pathLine.geometry
    if (!robot) {
      geometry.setDrawRange(0, 0)
      this.targetRing.visible = false
      return
    }
    this.robotPosition(robot, alpha, this.position)
    this.selectRing.position.set(this.position.x, 0.07, this.position.z)

    const cells = robot.next >= 0 ? [robot.next, ...robot.path] : robot.path
    const points = Math.min(cells.length + 1, PATH_POINTS)
    this.pathPositions[0] = this.position.x
    this.pathPositions[1] = 0.09
    this.pathPositions[2] = this.position.z
    for (let i = 1; i < points; i++) {
      const [x, z] = this.cellXZ(cells[i - 1])
      this.pathPositions[i * 3] = x
      this.pathPositions[i * 3 + 1] = 0.09
      this.pathPositions[i * 3 + 2] = z
    }
    geometry.setDrawRange(0, points > 1 ? points : 0)
    geometry.attributes.position.needsUpdate = true

    this.targetRing.visible = cells.length > 0
    if (cells.length > 0) {
      const [x, z] = this.cellXZ(cells[cells.length - 1])
      this.targetRing.position.set(x, 0.07, z)
      this.targetRing.scale.setScalar(0.7 + Math.sin(this.time * 6) * 0.08)
    }
  }

  /** What the pointer is over: a robot id, a shelf cell, or nothing. */
  private pick(event: PointerEvent): { robot?: number; shelf?: number } {
    const element = this.ctx.element
    if (!element) return {}
    const rect = element.getBoundingClientRect()
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const targets: THREE.Object3D[] = [this.racks, ...this.visuals.map((visual) => visual.root)]
    const hit = this.raycaster.intersectObjects(targets, true)[0]
    if (!hit) return {}
    if (hit.object === this.racks && hit.instanceId !== undefined) return { shelf: this.rackCells[hit.instanceId] }
    for (let object: THREE.Object3D | null = hit.object; object; object = object.parent) {
      if (object.userData.robotId !== undefined) return { robot: object.userData.robotId as number }
    }
    return {}
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.pointerStart = { x: event.clientX, y: event.clientY }
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse' || event.buttons !== 0) return
    const target = this.pick(event)
    const element = this.ctx.element
    if (element) element.style.cursor = target.robot !== undefined || target.shelf !== undefined ? 'pointer' : ''
  }

  /** A click (not a camera drag): a robot is selected to show its route; a shelf gets a rush order. */
  private onPointerUp = (event: PointerEvent): void => {
    const start = this.pointerStart
    this.pointerStart = null
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return
    const target = this.pick(event)
    if (target.robot !== undefined) {
      this.selected = this.selected === target.robot ? -1 : target.robot
    } else if (target.shelf !== undefined) {
      if (this.logic.rush(target.shelf)) {
        this.events.emit({
          type: 'rush_order',
          level: 'info',
          title: 'RUSH ORDER',
          message: 'That shelf jumps the queue. The nearest free robot takes it.',
        })
      }
    } else {
      this.selected = -1
    }
  }
}
