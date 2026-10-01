import * as THREE from 'three'
import { makeIsoCamera } from '../../three/cameras'
import { palette } from '../../three/palette'
import { makePlinth } from '../../three/plinth'
import { BaseSimulation } from '../core/BaseSimulation'
import type { ParamValue, StatValue } from '../core/Simulation'
import { FactoryLogic, LANE_LENGTH, STATIONS, type Machine, type MachineKind, type Product } from './FactoryLogic'

const BELT_Y = 1
const LANE_SPACING = 4.8
const MAX_PRODUCTS = 160
const PALLET_SLOTS = 12

const machineNames: Record<MachineKind, string> = {
  dispenser: 'Dispenser',
  mixer: 'Mixer',
  cutter: 'Cutter',
  oven: 'Oven',
  cooler: 'Cooling unit',
  packager: 'Packaging machine',
}

const statusColors = {
  idle: new THREE.Color(palette.green),
  processing: new THREE.Color(palette.green),
  blocked: new THREE.Color(palette.amber),
  jammed: new THREE.Color(palette.red),
}

const doughColors = {
  raw: new THREE.Color(0xf1e9d6),
  mixed: new THREE.Color(0xe6cf9a),
  shaped: new THREE.Color(0xecd9a8),
  baked: new THREE.Color(0xb8732c),
}

/** Rendering-side counterpart of a logic Machine. */
interface MachineVisual {
  machine: Machine
  root: THREE.Group
  lamp: THREE.MeshStandardMaterial
  /** Advances this machine's moving parts. */
  animate: (dt: number) => void
}

function laneX(s: number): number {
  return s - LANE_LENGTH / 2
}

export default class FactorySimulation extends BaseSimulation {
  private logic!: FactoryLogic
  private visuals: MachineVisual[] = []
  private hitTargets: THREE.Mesh[] = []
  private dough!: THREE.InstancedMesh
  private boxes!: THREE.InstancedMesh
  private pallets!: THREE.InstancedMesh
  private beltTextures: THREE.Texture[] = []
  private ovenGlow: THREE.MeshStandardMaterial[] = []
  private ovenLights: THREE.PointLight[] = []
  private laneZ: number[] = []
  private pointerStart: { x: number; y: number } | null = null

  private matrix = new THREE.Matrix4()
  private position = new THREE.Vector3()
  private scale = new THREE.Vector3()
  private rotation = new THREE.Quaternion()
  private color = new THREE.Color()
  private raycaster = new THREE.Raycaster()

  constructor() {
    super(makeIsoCamera(new THREE.Vector3(0.55, 0.78, 1)))
    this.params = { spawnRate: 60, conveyorSpeed: 2, machineSpeed: 1, ovenTemp: 180, failures: true, mtbf: 45 }
  }

  protected build(): void {
    const laneCount = this.isPreview ? 1 : 2
    this.laneZ = Array.from({ length: laneCount }, (_, lane) => (lane - (laneCount - 1) / 2) * LANE_SPACING)
    this.visuals = []
    this.hitTargets = []
    this.beltTextures = []
    this.ovenGlow = []
    this.ovenLights = []

    this.logic = new FactoryLogic(this.rng, laneCount, this.readParams())
    this.logic.onJam = (machine) => {
      this.events.emit({
        type: 'machine_jam',
        level: 'warn',
        title: 'MACHINE JAM',
        message: `${machineNames[machine.kind]} on line ${machine.lane + 1} stopped. Click the machine to repair it.`,
      })
    }

    const depth = laneCount * LANE_SPACING + 4.5
    this.world.add(makePlinth(LANE_LENGTH + 9, depth))

    const steel = new THREE.MeshStandardMaterial({ color: palette.steel, metalness: 0.55, roughness: 0.45 })
    const steelDark = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.5, roughness: 0.55 })
    const rubber = new THREE.MeshStandardMaterial({ color: palette.rubber, roughness: 0.9 })
    const materials = { steel, steelDark, rubber }

    for (let lane = 0; lane < laneCount; lane++) {
      const group = new THREE.Group()
      group.position.z = this.laneZ[lane]
      this.world.add(group)
      this.buildConveyor(group, materials)
      for (const station of STATIONS) {
        const machine = this.logic.machineAt(lane, station.kind)
        this.visuals.push(this.buildMachine(group, machine, materials))
      }
      this.buildPallet(group, materials)
    }
    this.buildDressing(depth)

    // Products are pooled by the logic and drawn as two instanced meshes.
    const doughGeometry = new THREE.CylinderGeometry(0.3, 0.32, 0.3, 14)
    this.dough = new THREE.InstancedMesh(
      doughGeometry,
      new THREE.MeshStandardMaterial({ roughness: 0.75 }),
      MAX_PRODUCTS,
    )
    this.dough.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.dough.setColorAt(0, doughColors.raw)
    this.boxes = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.62, 0.42, 0.62),
      new THREE.MeshStandardMaterial({ color: 0xc8975a, roughness: 0.8 }),
      MAX_PRODUCTS,
    )
    this.boxes.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.dough.count = 0
    this.boxes.count = 0
    this.dough.frustumCulled = false
    this.boxes.frustumCulled = false

    this.pallets = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.62, 0.42, 0.62),
      new THREE.MeshStandardMaterial({ color: 0xc8975a, roughness: 0.8 }),
      laneCount * PALLET_SLOTS,
    )
    this.pallets.count = 0
    this.pallets.frustumCulled = false
    this.world.add(this.dough, this.boxes, this.pallets)

    this.enableShadows(this.world)
    this.lighting.setShadowExtent(24)
    if (this.isPreview) this.setView(21.5, 5.2)
    else this.setView(23, 8 + laneCount)

    const element = this.ctx.element
    if (element && !this.isPreview) {
      element.addEventListener('pointerdown', this.onPointerDown)
      element.addEventListener('pointerup', this.onPointerUp)
    }
  }

  protected teardown(): void {
    const element = this.ctx?.element
    if (element) {
      element.removeEventListener('pointerdown', this.onPointerDown)
      element.removeEventListener('pointerup', this.onPointerUp)
    }
  }

  protected update(dt: number): void {
    this.logic.step(dt)
    for (const visual of this.visuals) visual.animate(dt)
  }

  render(alpha: number): void {
    const { logic } = this

    for (const texture of this.beltTextures) texture.offset.x = -logic.beltTravel * 2

    // Product instances.
    let doughCount = 0
    let boxCount = 0
    for (let lane = 0; lane < logic.laneCount; lane++) {
      const z = this.laneZ[lane]
      for (const product of logic.lanes[lane]) {
        const s = product.prevS + (product.s - product.prevS) * alpha
        if (product.state === 'packaged') {
          this.position.set(laneX(s), BELT_Y + 0.21, z)
          this.matrix.makeTranslation(this.position.x, this.position.y, this.position.z)
          if (boxCount < MAX_PRODUCTS) this.boxes.setMatrixAt(boxCount++, this.matrix)
          continue
        }
        if (doughCount >= MAX_PRODUCTS) continue
        const shape = this.doughShape(product)
        this.position.set(laneX(s), BELT_Y + 0.15 * shape.height, z)
        this.scale.set(shape.width, shape.height, shape.width)
        this.matrix.compose(this.position, this.rotation, this.scale)
        this.dough.setMatrixAt(doughCount, this.matrix)
        this.dough.setColorAt(doughCount, this.color)
        doughCount++
      }
    }
    this.dough.count = doughCount
    this.boxes.count = boxCount
    this.dough.instanceMatrix.needsUpdate = true
    this.boxes.instanceMatrix.needsUpdate = true
    if (this.dough.instanceColor) this.dough.instanceColor.needsUpdate = true

    // Finished boxes stack on each lane's pallet; a full pallet is carted away.
    let palletCount = 0
    for (let lane = 0; lane < logic.laneCount; lane++) {
      const stacked = logic.machineAt(lane, 'packager').processed % (PALLET_SLOTS + 1)
      for (let i = 0; i < stacked; i++) {
        const layer = Math.floor(i / 4)
        this.matrix.makeTranslation(
          laneX(LANE_LENGTH) + 2.1 + ((i % 2) - 0.5) * 0.68,
          0.37 + layer * 0.44,
          this.laneZ[lane] + ((Math.floor(i / 2) % 2) - 0.5) * 0.68,
        )
        this.pallets.setMatrixAt(palletCount++, this.matrix)
      }
    }
    this.pallets.count = palletCount
    this.pallets.instanceMatrix.needsUpdate = true

    // Status lamps: steady when healthy, blinking red when jammed.
    const blink = Math.sin(this.time * 14) > 0 ? 1 : 0.15
    for (const visual of this.visuals) {
      const status = visual.machine.status
      visual.lamp.emissive.copy(statusColors[status])
      visual.lamp.emissiveIntensity = status === 'jammed' ? 2.4 * blink : status === 'idle' ? 0.5 : 1.6
      visual.root.position.x = status === 'jammed' ? Math.sin(this.time * 46) * 0.015 : 0
    }

    const heat = THREE.MathUtils.clamp((this.num('ovenTemp') - 120) / 140, 0, 1)
    for (const glow of this.ovenGlow) glow.emissiveIntensity = 0.5 + heat * 2.2
    for (const light of this.ovenLights) light.intensity = 6 + heat * 22
  }

  protected onParam(_key: string, _value: ParamValue): void {
    this.logic.params = this.readParams()
  }

  getStats(): Record<string, StatValue> {
    const { logic } = this
    const downtime = Math.floor(logic.downtime)
    return {
      productionPerMin: `${logic.productionPerMinute().toFixed(0)} / min`,
      completed: logic.completed,
      active: logic.activeProducts,
      efficiency: (logic.efficiency() * 100).toFixed(0),
      machines: `${logic.runningMachines} / ${logic.machines.length}`,
      downtime: `${String(Math.floor(downtime / 60)).padStart(2, '0')}:${String(downtime % 60).padStart(2, '0')}`,
    }
  }

  entityCount(): number {
    return this.logic.activeProducts
  }

  private readParams() {
    return {
      spawnRate: this.num('spawnRate'),
      conveyorSpeed: this.num('conveyorSpeed'),
      machineSpeed: this.num('machineSpeed'),
      ovenTemp: this.num('ovenTemp'),
      failures: this.bool('failures'),
      mtbf: this.num('mtbf'),
    }
  }

  /** Size and color of a product for its current state. Writes this.color. */
  private doughShape(product: Product): { width: number; height: number } {
    switch (product.state) {
      case 'raw':
        this.color.copy(doughColors.raw)
        return { width: 0.72, height: 1.25 }
      case 'mixed':
        this.color.copy(doughColors.mixed)
        return { width: 0.95, height: 0.85 }
      case 'shaped':
        this.color.copy(doughColors.shaped)
        return { width: 1.05, height: 0.36 }
      case 'baking': {
        // Browns and rises as it bakes; stays baked after leaving the oven.
        const baked = product.stage > 2 ? 1 : Math.min(1, product.dwell / this.logic.dwellTime('oven'))
        this.color.copy(doughColors.shaped).lerp(doughColors.baked, baked)
        return { width: 1.05, height: 0.36 + baked * 0.2 }
      }
      default:
        this.color.copy(doughColors.baked)
        return { width: 1.05, height: 0.56 }
    }
  }

  private buildConveyor(group: THREE.Group, materials: Record<string, THREE.Material>): void {
    const bed = new THREE.Mesh(new THREE.BoxGeometry(LANE_LENGTH + 0.6, 0.28, 1.5), materials.steelDark)
    bed.position.y = BELT_Y - 0.16
    group.add(bed)

    // The belt surface scrolls by offsetting a small striped texture.
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
    texture.repeat.set(LANE_LENGTH * 2, 1)
    texture.colorSpace = THREE.SRGBColorSpace
    this.beltTextures.push(texture)
    const belt = new THREE.Mesh(
      new THREE.PlaneGeometry(LANE_LENGTH + 0.6, 1.2),
      new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95 }),
    )
    belt.rotation.x = -Math.PI / 2
    belt.position.y = BELT_Y - 0.015
    group.add(belt)

    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(LANE_LENGTH + 0.6, 0.12, 0.08), materials.steel)
      rail.position.set(0, BELT_Y + 0.02, side * 0.72)
      group.add(rail)
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(LANE_LENGTH + 2, 0.02, 0.1),
        new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.8 }),
      )
      stripe.position.set(0, 0.011, side * 1.7)
      group.add(stripe)
    }

    const legCount = Math.floor(LANE_LENGTH / 2.4) + 1
    const legs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, BELT_Y - 0.3, 0.14), materials.steelDark, legCount * 2)
    let index = 0
    for (let i = 0; i < legCount; i++) {
      for (const side of [-1, 1]) {
        this.matrix.makeTranslation(-LANE_LENGTH / 2 + i * 2.4 + 0.2, (BELT_Y - 0.3) / 2, side * 0.6)
        legs.setMatrixAt(index++, this.matrix)
      }
    }
    group.add(legs)
  }

  private buildMachine(lane: THREE.Group, machine: Machine, materials: Record<string, THREE.Material>): MachineVisual {
    const root = new THREE.Group()
    lane.add(root)
    const length = Math.max(machine.end - machine.start, 1.6)
    const centerX = laneX((machine.start + machine.end) / 2)
    const { steel, steelDark } = materials

    const add = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      x: number,
      y: number,
      z: number,
      parent: THREE.Object3D = root,
    ) => {
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(x, y, z)
      parent.add(mesh)
      return mesh
    }
    const accent = (color: number) => new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.5 })

    /** Two columns and a cross beam straddling the belt. */
    const portal = (x: number, height: number) => {
      const column = new THREE.BoxGeometry(0.22, height, 0.22)
      add(column, steel, x, height / 2, -0.98)
      add(column, steel, x, height / 2, 0.98)
      add(new THREE.BoxGeometry(0.4, 0.24, 2.18), steel, x, height, 0)
    }

    let lampY = 3
    let animate: (dt: number) => void = () => {}

    switch (machine.kind) {
      case 'dispenser': {
        portal(centerX, 2.5)
        const hopper = add(new THREE.CylinderGeometry(0.95, 0.26, 1.2, 4), accent(palette.steelLight), centerX, 2.5, 0)
        hopper.rotation.y = Math.PI / 4
        add(new THREE.BoxGeometry(1.42, 0.14, 1.42), steelDark, centerX, 3.14, 0)
        const nozzle = add(new THREE.CylinderGeometry(0.2, 0.2, 0.36, 10), steelDark, centerX, 1.78, 0)
        let last = machine.processed
        let pulse = 0
        animate = (dt) => {
          if (machine.processed !== last) {
            last = machine.processed
            pulse = 1
          }
          pulse = Math.max(0, pulse - dt * 5)
          nozzle.position.y = 1.78 - pulse * 0.14
        }
        lampY = 3.45
        break
      }
      case 'mixer': {
        portal(centerX, 2.6)
        add(new THREE.BoxGeometry(0.9, 0.6, 0.9), accent(palette.amber), centerX, 3, 0)
        const whisk = new THREE.Group()
        whisk.position.set(centerX, 2, 0)
        root.add(whisk)
        add(new THREE.CylinderGeometry(0.06, 0.06, 1.1, 8), steelDark, 0, 0, 0, whisk)
        const paddle = new THREE.BoxGeometry(0.72, 0.16, 0.08)
        add(paddle, materials.steel, 0, -0.5, 0, whisk)
        add(paddle, materials.steel, 0, -0.5, 0, whisk).rotation.y = Math.PI / 2
        animate = (dt) => {
          const working = machine.item !== null && machine.status !== 'jammed'
          whisk.position.y += ((working ? 1.84 : 2.1) - whisk.position.y) * Math.min(1, dt * 12)
          if (machine.status !== 'jammed') whisk.rotation.y += dt * (working ? 16 : 1.5)
        }
        lampY = 3.5
        break
      }
      case 'cutter': {
        portal(centerX, 2.6)
        add(new THREE.BoxGeometry(0.7, 0.4, 0.7), accent(palette.cyan), centerX, 2.92, 0)
        const press = new THREE.Group()
        press.position.set(centerX, 2.15, 0)
        root.add(press)
        add(new THREE.CylinderGeometry(0.09, 0.09, 0.9, 8), steelDark, 0, 0.5, 0, press)
        add(new THREE.CylinderGeometry(0.4, 0.4, 0.26, 16), materials.steel, 0, 0, 0, press)
        animate = () => {
          // One stamp per product: down at half progress, back up by the end.
          press.position.y = 2.15 - Math.sin(machine.progress * Math.PI) * 0.82
        }
        lampY = 3.35
        break
      }
      case 'oven': {
        const shell = accent(0x4a3f3a)
        const glow = new THREE.MeshStandardMaterial({ color: 0x2a1408, emissive: 0xff5a1a, emissiveIntensity: 1.4 })
        this.ovenGlow.push(glow)
        add(new THREE.BoxGeometry(length, 2.5, 0.16), shell, centerX, 1.55, -1) // back wall
        add(new THREE.BoxGeometry(length - 0.1, 1.4, 0.04), glow, centerX, 1.8, -0.9) // glowing interior
        add(new THREE.BoxGeometry(length, 0.95, 0.16), shell, centerX, 0.78, 1) // front, below the window
        add(new THREE.BoxGeometry(length, 0.7, 0.16), shell, centerX, 2.45, 1) // front, above the window
        add(new THREE.BoxGeometry(length + 0.3, 0.26, 2.4), shell, centerX, 2.93, 0) // roof
        for (let i = 0; i <= 4; i++) {
          add(new THREE.BoxGeometry(0.16, 0.9, 0.18), shell, centerX - length / 2 + (i * length) / 4, 1.68, 1)
        }
        for (let i = 0; i < 4; i++) {
          add(new THREE.BoxGeometry(length * 0.2, 0.06, 1.3), glow, centerX - length * 0.375 + i * length * 0.25, 2.72, 0)
        }
        add(new THREE.BoxGeometry(length + 0.34, 0.1, 2.44), accent(palette.amber), centerX, 3.1, 0)
        for (const offset of [-0.3, 0.3]) {
          add(new THREE.CylinderGeometry(0.22, 0.26, 1, 10), steelDark, centerX + length * offset, 3.6, -0.5)
        }
        if (!this.isPreview) {
          const light = new THREE.PointLight(0xff6a20, 14, 7, 1.6)
          light.position.set(centerX, 1.9, 1.6)
          root.add(light)
          this.ovenLights.push(light)
        }
        // Doors lift when a product is at the threshold.
        const doors = [machine.start, machine.end].map((s) =>
          add(new THREE.BoxGeometry(0.1, 1.35, 1.7), steelDark, laneX(s), 1.72, 0),
        )
        const openness = [0, 0]
        animate = (dt) => {
          const products = this.logic.lanes[machine.lane]
          ;[machine.start, machine.end].forEach((s, i) => {
            const near = machine.status !== 'jammed' && products.some((product) => Math.abs(product.s - s) < 1.1)
            openness[i] += ((near ? 1 : 0) - openness[i]) * Math.min(1, dt * 8)
            doors[i].position.y = 1.72 + openness[i] * 1.05
          })
        }
        lampY = 3.5
        break
      }
      case 'cooler': {
        const frame = accent(0x39505e)
        for (const x of [-length / 2, length / 2]) portal(centerX + x, 2.5)
        for (const z of [-0.98, 0.98]) add(new THREE.BoxGeometry(length, 0.16, 0.16), frame, centerX, 2.5, z)
        const strip = new THREE.MeshStandardMaterial({ color: 0x0c2a36, emissive: palette.cyan, emissiveIntensity: 1.6 })
        add(new THREE.BoxGeometry(length - 0.6, 0.06, 0.06), strip, centerX, 2.38, 1.06)
        const fans: THREE.Group[] = []
        for (let i = 0; i < 3; i++) {
          const x = centerX + (i - 1) * (length / 3)
          add(new THREE.CylinderGeometry(0.78, 0.78, 0.22, 20, 1, true), frame, x, 2.56, 0).material.side = THREE.DoubleSide
          const fan = new THREE.Group()
          fan.position.set(x, 2.56, 0)
          root.add(fan)
          const blade = new THREE.BoxGeometry(1.36, 0.04, 0.24)
          for (let b = 0; b < 3; b++) add(blade, materials.steel, 0, 0, 0, fan).rotation.y = (b * Math.PI) / 3
          fans.push(fan)
        }
        animate = (dt) => {
          if (machine.status === 'jammed') return
          for (const fan of fans) fan.rotation.y += dt * 13 * this.num('machineSpeed')
        }
        lampY = 3
        break
      }
      case 'packager': {
        portal(centerX - 0.7, 2.7)
        portal(centerX + 0.7, 2.7)
        add(new THREE.BoxGeometry(1.8, 0.3, 0.9), accent(0x2f8f8a), centerX, 2.95, 0)
        const arm = new THREE.Group()
        arm.position.set(centerX, 2.25, 0)
        root.add(arm)
        add(new THREE.BoxGeometry(0.14, 1, 0.14), steelDark, 0, 0.55, 0, arm)
        add(new THREE.BoxGeometry(0.8, 0.12, 0.8), materials.steel, 0, 0.02, 0, arm)
        for (const side of [-1, 1]) {
          add(new THREE.BoxGeometry(0.06, 0.4, 0.8), materials.steel, side * 0.38, -0.2, 0, arm)
        }
        // Flat-packed cartons waiting beside the machine.
        for (let i = 0; i < 4; i++) {
          add(new THREE.BoxGeometry(0.7, 0.07, 0.7), accent(0xc8975a), centerX, 0.04 + i * 0.08, -1.75)
        }
        animate = () => {
          arm.position.y = 2.25 - Math.sin(machine.progress * Math.PI) * 0.62
        }
        lampY = 3.4
        break
      }
    }

    const lamp = new THREE.MeshStandardMaterial({ color: 0x11161b, emissive: palette.green, emissiveIntensity: 1 })
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 6), steelDark, centerX - length / 2 + 0.2, lampY - 0.25, 0.98)
    add(new THREE.SphereGeometry(0.13, 12, 8), lamp, centerX - length / 2 + 0.2, lampY, 0.98)

    // Invisible box used for click-to-repair picking.
    const hit = add(
      new THREE.BoxGeometry(length + 0.4, 3.4, 2.6),
      new THREE.MeshBasicMaterial({ visible: false }),
      centerX,
      1.7,
      0,
    )
    hit.userData.machineId = machine.id
    this.hitTargets.push(hit)

    return { machine, root, lamp, animate }
  }

  private buildPallet(group: THREE.Group, materials: Record<string, THREE.Material>): void {
    const x = laneX(LANE_LENGTH)
    const chute = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.1, 1.2), materials.steel)
    chute.position.set(x + 0.95, 0.72, 0)
    chute.rotation.z = -0.42
    group.add(chute)
    const pallet = new THREE.Mesh(
      new THREE.BoxGeometry(1.7, 0.16, 1.7),
      new THREE.MeshStandardMaterial({ color: 0x6b4f33, roughness: 0.9 }),
    )
    pallet.position.set(x + 2.1, 0.08, 0)
    group.add(pallet)
  }

  /** Seeded set dressing: crates, drums and floor pipes around the lines. */
  private buildDressing(depth: number): void {
    const crate = new THREE.BoxGeometry(1, 1, 1)
    const drum = new THREE.CylinderGeometry(0.4, 0.4, 1.1, 14)
    const crateMaterial = new THREE.MeshStandardMaterial({ color: 0x4d5863, roughness: 0.8 })
    const drumMaterials = [palette.cyan, palette.red, palette.amber].map(
      (color) => new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.55 }),
    )
    const back = -depth / 2 + 1.1
    const count = this.isPreview ? 7 : this.rng.int(10, 15)
    let x = -LANE_LENGTH / 2 - 2
    for (let i = 0; i < count && x < LANE_LENGTH / 2 + 2; i++) {
      x += this.rng.range(1.4, 4.2)
      if (this.rng.chance(0.55)) {
        const size = this.rng.range(0.7, 1.2)
        const mesh = new THREE.Mesh(crate, crateMaterial)
        mesh.scale.setScalar(size)
        mesh.position.set(x, size / 2, back + this.rng.range(-0.2, 0.3))
        mesh.rotation.y = this.rng.range(-0.3, 0.3)
        this.world.add(mesh)
        if (this.rng.chance(0.35)) {
          const top = new THREE.Mesh(crate, crateMaterial)
          top.scale.setScalar(size * 0.7)
          top.position.set(x + 0.1, size + size * 0.35, mesh.position.z)
          top.rotation.y = this.rng.range(-0.6, 0.6)
          this.world.add(top)
        }
      } else {
        const mesh = new THREE.Mesh(drum, this.rng.pick(drumMaterials))
        mesh.position.set(x, 0.55, back + this.rng.range(-0.2, 0.3))
        this.world.add(mesh)
      }
    }
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.pointerStart = { x: event.clientX, y: event.clientY }
  }

  /** A click (not a camera drag) on a jammed machine repairs it. */
  private onPointerUp = (event: PointerEvent): void => {
    const start = this.pointerStart
    this.pointerStart = null
    const element = this.ctx.element
    if (!start || !element || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return
    const rect = element.getBoundingClientRect()
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(pointer, this.camera)
    const hit = this.raycaster.intersectObjects(this.hitTargets, false)[0]
    if (hit) {
      this.logic.repair(hit.object.userData.machineId as number)
      this.events.emit({ type: 'machine_repaired' })
    }
  }
}
