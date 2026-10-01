import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { makeIsoCamera } from '../../three/cameras'
import { mergeStaticMeshes } from '../../three/merge'
import { palette } from '../../three/palette'
import { makePlinth } from '../../three/plinth'
import { BaseSimulation } from '../core/BaseSimulation'
import { Rng } from '../core/random'
import type { ParamValue, StatValue } from '../core/Simulation'
import { RackLogic, T_AMBIENT, T_CRIT, type RackParams, type ServerNode } from './RackLogic'

const UNIT_H = 0.5
const RACK_W = 3.6
const RACK_D = 2.8
const RACK_GAP = 2
const FRAME = 0.16
/** Rack units above the servers: firewall, switch, patch panel. */
const TOP_UNITS = 3
const BAYS = 12
const SLIDE = 0.34
/** Height the casters lift the cabinet off the floor. */
const LIFT = 0.13
const DOOR_OPEN = -Math.PI * 0.56
const FACE_W = RACK_W - FRAME * 2.4
const FACE_Z = RACK_D / 2 - FRAME
const DRIVES = 6
const PORTS = 16
const BURST_JOBS = 60
/** Hot-air streaks above each cabinet and cold-air streaks in front of it. */
const STREAKS = 16
const GRAPH_SAMPLES = 160

const statusColor = {
  idle: new THREE.Color(palette.green),
  busy: new THREE.Color(palette.green),
  throttled: new THREE.Color(palette.amber),
  down: new THREE.Color(palette.red),
}
const warm = new THREE.Color(palette.amber)
const hot = new THREE.Color(palette.red)
const ledOff = new THREE.Color(0x0a1410)
const ledDrive = new THREE.Color(0x5fd38d)
const ledLink = new THREE.Color(0xffb020)
const ledStorage = new THREE.Color(0x4cc9f0)
const leadColors = [palette.red, 0xff8a1f, palette.amber]
const CABLE_BLUE = 0x2f6fe0

/** Hardware flavours. All are 1U and behave the same; they differ in what is on the front panel. */
type ServerKind = 'compute' | 'storage' | 'gpu' | 'blade'

/** Rendering-side counterpart of one logic node. */
interface ServerVisual {
  node: ServerNode
  kind: ServerKind
  rack: number
  /** Slot index within the rack. */
  unit: number
  /** Everything that slides out with the server. */
  group: THREE.Group
  /** 0 = racked, 1 = pulled out on its rails. */
  slide: number
  chassis: THREE.MeshStandardMaterial
  statusLamp: THREE.MeshStandardMaterial
  activity: THREE.MeshStandardMaterial
}

interface RackVisual {
  x: number
  servers: ServerVisual[]
  caddies: THREE.InstancedMesh
  handles: THREE.InstancedMesh
  storageLeds: THREE.InstancedMesh | null
  /** Only the end cabinet keeps its door; one between cabinets would hide its neighbour. */
  door: THREE.Group | null
  doorOpen: boolean
  fans: THREE.Group[]
  /** One LED per drive bay, colored per frame from node activity. */
  driveLeds: THREE.InstancedMesh
  /** One link LED per switch port. */
  linkLeds: THREE.InstancedMesh
  hotAir: THREE.InstancedMesh
  hotAirMaterial: THREE.MeshBasicMaterial
  coldAir: THREE.InstancedMesh
  coldAirMaterial: THREE.MeshBasicMaterial
}

export default class RackSimulation extends BaseSimulation {
  private logic!: RackLogic
  /** Randomness for visual flicker only; never feeds the simulation. */
  private fx = new Rng(1)
  private racks: RackVisual[] = []
  private hitTargets: THREE.Mesh[] = []
  private units = 10
  /** Rack units below the servers: PDU, UPS and (full view) a storage shelf. */
  private baseUnits = 3
  private servers: ServerVisual[] = []
  private selected = -1
  private hoverFrame!: THREE.LineSegments
  private selectFrame!: THREE.LineSegments
  private rackHeight = 5
  private display: { texture: THREE.CanvasTexture; context: CanvasRenderingContext2D } | null = null
  private history: { power: number; util: number }[] = []
  private sampleTimer = 0
  private coolingStrip: THREE.MeshStandardMaterial | null = null
  private coolerFan: THREE.Group | null = null
  private pointerStart: { x: number; y: number } | null = null

  private matrix = new THREE.Matrix4()
  private position = new THREE.Vector3()
  private scale = new THREE.Vector3()
  private quaternion = new THREE.Quaternion()
  private raycaster = new THREE.Raycaster()

  constructor() {
    super(makeIsoCamera(new THREE.Vector3(0.85, 0.72, 1)))
    this.params = { arrivalRate: 180, jobSize: 140, cooling: 0.6, powerCap: 12, failures: true }
  }

  protected build(): void {
    const rackCount = this.isPreview ? 1 : 2
    this.units = this.isPreview ? 8 : 10
    this.baseUnits = this.isPreview ? 3 : 5
    this.rackHeight = (this.units + this.baseUnits + TOP_UNITS) * UNIT_H + FRAME * 2
    this.racks = []
    this.servers = []
    this.selected = -1
    this.hitTargets = []
    this.history = []
    this.sampleTimer = 0
    this.fx = new Rng(this.seed + 1)
    // Center the tall scene on the camera's look-at point.
    this.world.position.y = -(this.rackHeight + 2.4) * 0.5

    this.logic = new RackLogic(this.rng, rackCount * this.units, this.readParams())
    this.logic.onDown = (node) => {
      this.events.emit({
        type: 'node_down',
        level: 'warn',
        title: 'NODE DOWN',
        message: `Server ${this.nodeLabel(node.id)} overheated and dropped offline. Click it to restart, or add cooling.`,
      })
    }

    const spanX = rackCount * RACK_W + (rackCount - 1) * RACK_GAP
    const floorW = spanX + 8.4
    const floorD = RACK_D + 6.4
    const floor = makePlinth(floorW, floorD)
    floor.position.z = 1.2
    this.world.add(floor)
    this.buildFloor(floorW, floorD)

    const steel = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.6, roughness: 0.4 })
    for (let r = 0; r < rackCount; r++) {
      const x = (r - (rackCount - 1) / 2) * (RACK_W + RACK_GAP)
      this.racks.push(this.buildRack(x, r, steel))
    }

    // Outlines marking the hovered and the selected server.
    const outline = new THREE.EdgesGeometry(new THREE.BoxGeometry(RACK_W + 0.08, UNIT_H, RACK_D + 0.08))
    this.hoverFrame = new THREE.LineSegments(outline, new THREE.LineBasicMaterial({ color: palette.amber }))
    this.selectFrame = new THREE.LineSegments(outline, new THREE.LineBasicMaterial({ color: palette.white }))
    this.hoverFrame.visible = false
    this.selectFrame.visible = false
    this.world.add(this.hoverFrame, this.selectFrame)

    this.buildDisplay(spanX, steel)
    this.buildCooler(-spanX / 2 - 2.5, steel)
    this.buildDressing(spanX, steel)

    mergeStaticMeshes(this.world)
    this.enableShadows(this.world)
    for (const rack of this.racks) {
      rack.hotAir.castShadow = false
      rack.coldAir.castShadow = false
    }
    this.lighting.setShadowExtent(spanX + 9)
    this.setView(spanX * 0.62 + 5.4, this.rackHeight * 0.6 + (this.isPreview ? 2.6 : 3.6))

    const element = this.ctx.element
    if (element && !this.isPreview) {
      element.addEventListener('pointerdown', this.onPointerDown)
      element.addEventListener('pointerup', this.onPointerUp)
      element.addEventListener('pointermove', this.onPointerMove)
      element.addEventListener('pointerleave', this.onPointerLeave)
    }
  }

  protected teardown(): void {
    const element = this.ctx?.element
    if (element) {
      element.removeEventListener('pointerdown', this.onPointerDown)
      element.removeEventListener('pointerup', this.onPointerUp)
      element.removeEventListener('pointermove', this.onPointerMove)
      element.removeEventListener('pointerleave', this.onPointerLeave)
      element.style.cursor = ''
    }
    this.display = null
    this.coolingStrip = null
    this.coolerFan = null
  }

  protected update(dt: number): void {
    this.logic.step(dt)
    const cooling = this.num('cooling')

    for (const rack of this.racks) {
      // Exhaust fans spin with the cooling effort; hotter racks run harder.
      const speed = (2 + cooling * 9) * (0.5 + this.rackHeat(rack))
      for (const fan of rack.fans) fan.rotation.z += speed * dt
      this.flickerLeds(rack)
      const goal = rack.doorOpen ? DOOR_OPEN : 0
      if (rack.door) rack.door.rotation.y += (goal - rack.door.rotation.y) * Math.min(1, dt * 7)
    }
    for (const visual of this.servers) {
      const goal = visual.node.id === this.selected ? 1 : 0
      if (Math.abs(goal - visual.slide) < 0.001) continue
      visual.slide += (goal - visual.slide) * Math.min(1, dt * 10)
      visual.group.position.z = visual.slide * SLIDE
      this.placeDrives(this.racks[visual.rack], visual, visual.slide * SLIDE)
    }
    if (this.coolerFan) this.coolerFan.rotation.z += (1.5 + cooling * 14) * dt

    this.sampleTimer += dt
    if (this.sampleTimer >= 0.12) {
      this.sampleTimer = 0
      this.history.push({ power: this.logic.totalPower, util: this.logic.utilization() })
      if (this.history.length > GRAPH_SAMPLES) this.history.shift()
      this.drawDisplay()
    }
  }

  render(_alpha: number): void {
    const blink = Math.sin(this.time * 16) > 0 ? 1 : 0.12
    const cooling = this.num('cooling')
    for (const rack of this.racks) {
      for (const visual of rack.servers) this.paintServer(visual, blink)
      this.paintAir(rack.hotAir, this.rackHeat(rack), 0.4 + cooling * 0.5, this.rackHeight + 0.3, 1.9, -RACK_D * 0.05, RACK_D * 0.5)
      rack.hotAirMaterial.opacity = 0.12 + this.rackHeat(rack) * 0.4
      this.paintAir(rack.coldAir, 0.25 + cooling * 0.75, 0.3 + cooling * 0.6, 0.05, this.rackHeight * 0.55, RACK_D / 2 + 0.9, 0.7)
      rack.coldAirMaterial.opacity = 0.08 + cooling * 0.3
    }
    if (this.coolingStrip) this.coolingStrip.emissiveIntensity = 0.3 + cooling * 2.4

    const selected = this.servers[this.selected]
    this.selectFrame.visible = selected !== undefined
    if (selected) {
      this.selectFrame.position.set(this.racks[selected.rack].x, this.serverY(selected.unit) + LIFT, selected.slide * SLIDE)
    }
  }

  protected onParam(_key: string, _value: ParamValue): void {
    this.logic.params = this.readParams()
  }

  action(key: string): void {
    if (key === 'power') {
      this.togglePower()
      return
    }
    if (key !== 'burst') return
    this.logic.burst(BURST_JOBS)
    this.events.emit({
      type: 'traffic_burst',
      level: 'info',
      title: 'TRAFFIC BURST',
      message: `${BURST_JOBS} jobs injected. Watch the queue drain as nodes heat up.`,
    })
  }

  /** Switches the selected server off, or back on. */
  private togglePower(): void {
    const node = this.logic.nodes[this.selected]
    if (!node) {
      this.events.emit({ type: 'no_selection', level: 'info', title: 'NO SERVER SELECTED', message: 'Click a server to pull it out first.' })
      return
    }
    this.logic.setPower(node.id, node.held)
    this.events.emit({
      type: node.held ? 'node_off' : 'node_on',
      level: 'info',
      title: node.held ? 'NODE POWERED OFF' : 'NODE POWERING ON',
      message: node.held
        ? `Server ${this.nodeLabel(node.id)} is off. Its jobs went back to the queue.`
        : `Server ${this.nodeLabel(node.id)} is booting.`,
    })
  }

  getStats(): Record<string, StatValue> {
    const { logic } = this
    const stats: Record<string, StatValue> = {
      throughput: `${logic.throughput().toFixed(0)} /s`,
      queue: logic.queue.length,
      utilization: (logic.utilization() * 100).toFixed(0),
      power: `${logic.totalPower.toFixed(1)} / ${this.num('powerCap').toFixed(0)} kW`,
      maxTemp: logic.maxTemp.toFixed(0),
      avgTemp: logic.avgTemp.toFixed(0),
      latency: `${(logic.avgLatency() * 1000).toFixed(0)} ms`,
      nodes: `${logic.runningNodes} / ${logic.nodes.length}`,
      dropped: logic.dropped,
    }
    const node = logic.nodes[this.selected]
    if (node) {
      const state = node.held ? 'OFF' : node.status === 'down' ? 'REBOOTING' : node.status.toUpperCase()
      stats.selected = `${this.nodeLabel(node.id)} · ${state}`
      stats.selTemp = node.temp.toFixed(0)
      stats.selJobs = `${node.jobs.length} / ${node.slots}`
    }
    return stats
  }

  entityCount(): number {
    return this.logic.runningJobs + this.logic.queue.length
  }

  private readParams(): RackParams {
    return {
      arrivalRate: this.num('arrivalRate'),
      jobSize: this.num('jobSize'),
      cooling: this.num('cooling'),
      powerCap: this.num('powerCap'),
      failures: this.bool('failures'),
    }
  }

  /** 0 (cool) to 1 (critical). */
  private heat(temp: number): number {
    return THREE.MathUtils.clamp((temp - (T_AMBIENT + 14)) / (T_CRIT - (T_AMBIENT + 14)), 0, 1)
  }

  private rackHeat(rack: RackVisual): number {
    let max = 0
    for (const visual of rack.servers) max = Math.max(max, this.heat(visual.node.temp))
    return max
  }

  private nodeLabel(id: number): string {
    return `R${Math.floor(id / this.units) + 1}-U${(id % this.units) + 1}`
  }

  private add(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(x, y, z)
    parent.add(mesh)
    return mesh
  }

  private paintServer(visual: ServerVisual, blink: number): void {
    const node = visual.node
    const h = this.heat(node.temp)

    // Chassis glows from amber to red as it heats; cool servers stay dark steel.
    if (node.status === 'down') {
      visual.chassis.emissiveIntensity = 0
      visual.chassis.color.set(0x15181c)
    } else {
      visual.chassis.color.set(palette.steelDark)
      visual.chassis.emissive.copy(h > 0.5 ? hot : warm)
      visual.chassis.emissiveIntensity = h * 0.9
    }

    const status = node.status
    visual.statusLamp.emissive.copy(statusColor[status])
    visual.statusLamp.emissiveIntensity =
      node.held ? 0 : status === 'down' ? 2.2 * blink : status === 'idle' ? 0.35 : status === 'throttled' ? 1.8 : 1.4

    // Activity bar flickers with the number of in-flight jobs.
    const load = node.jobs.length / node.slots
    const flicker = status === 'down' ? 0 : load > 0 ? 0.5 + 0.5 * Math.sin(this.time * 30 + node.id * 2.3) : 0
    visual.activity.emissiveIntensity = load > 0 ? 0.6 + flicker * load * 1.6 : 0.05
  }

  /** Drive LEDs blink in proportion to each node's load; switch ports to rack traffic. */
  private flickerLeds(rack: RackVisual): void {
    let busy = 0
    rack.servers.forEach((visual, u) => {
      const node = visual.node
      const load = node.status === 'down' ? 0 : node.jobs.length / node.slots
      busy += load
      for (let d = 0; d < DRIVES; d++) {
        const lit = node.status !== 'down' && (load === 0 ? d === 0 : this.fx.chance(0.25 + load * 0.6))
        rack.driveLeds.setColorAt(u * DRIVES + d, lit ? ledDrive : ledOff)
      }
    })
    const traffic = busy / rack.servers.length
    for (let p = 0; p < PORTS; p++) {
      // Only ports with a cable plugged in carry traffic.
      const lit = p < rack.servers.length && this.fx.chance(0.15 + traffic * 0.8)
      rack.linkLeds.setColorAt(p, lit ? ledLink : ledOff)
    }
    if (rack.storageLeds) {
      for (let b = 0; b < BAYS; b++) rack.storageLeds.setColorAt(b, this.fx.chance(0.1 + traffic * 0.7) ? ledStorage : ledOff)
      rack.storageLeds.instanceColor!.needsUpdate = true
    }
    rack.driveLeds.instanceColor!.needsUpdate = true
    rack.linkLeds.instanceColor!.needsUpdate = true
  }

  /** Rising air streaks, in the rack group's local space. */
  private paintAir(
    mesh: THREE.InstancedMesh,
    strength: number,
    speed: number,
    baseY: number,
    rise: number,
    centerZ: number,
    depth: number,
  ): void {
    for (let i = 0; i < STREAKS; i++) {
      const seed = i * 1.37
      const phase = (this.time * speed + seed) % 1
      const s = strength * Math.sin(phase * Math.PI)
      this.position.set((((seed * 7.1) % 1) - 0.5) * RACK_W * 0.8, baseY + phase * rise, centerZ + (((seed * 3.3) % 1) - 0.5) * depth)
      if (s < 0.02) this.scale.setScalar(0.0001)
      else this.scale.set(0.04 + s * 0.05, 0.3 + s * 0.6, 0.04 + s * 0.05)
      this.matrix.compose(this.position, this.quaternion, this.scale)
      mesh.setMatrixAt(i, this.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
  }

  private buildRack(x: number, index: number, steel: THREE.Material): RackVisual {
    const group = new THREE.Group()
    group.position.x = x
    this.world.add(group)
    const { units } = this
    const height = this.rackHeight

    const panel = new THREE.MeshStandardMaterial({ color: 0x14181d, metalness: 0.4, roughness: 0.6 })
    const bezel = new THREE.MeshStandardMaterial({ color: 0x1b2026, metalness: 0.3, roughness: 0.7 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.8 })
    const light = new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.7, roughness: 0.35 })

    // Cabinet: corner posts, floor and roof plates, back panel.
    const post = new THREE.BoxGeometry(FRAME, height, FRAME)
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) this.add(group, post, steel, (sx * (RACK_W - FRAME)) / 2, height / 2, (sz * (RACK_D - FRAME)) / 2)
    }
    const plate = new THREE.BoxGeometry(RACK_W, FRAME, RACK_D)
    this.add(group, plate, steel, 0, FRAME / 2, 0)
    this.add(group, plate, steel, 0, height - FRAME / 2, 0)
    this.add(group, new THREE.BoxGeometry(RACK_W - FRAME, height - FRAME * 2, 0.06), panel, 0, height / 2, -RACK_D / 2 + FRAME / 2)
    // Casters.
    const wheel = new THREE.CylinderGeometry(0.11, 0.11, 0.09, 12)
    wheel.rotateZ(Math.PI / 2)
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        this.add(group, wheel, dark, sx * (RACK_W / 2 - 0.22), -0.02, sz * (RACK_D / 2 - 0.22))
        this.add(group, new THREE.BoxGeometry(0.16, 0.06, 0.2), light, sx * (RACK_W / 2 - 0.22), 0.02, sz * (RACK_D / 2 - 0.22))
      }
    }
    group.position.y = LIFT

    const totalUnits = units + this.baseUnits + TOP_UNITS
    // Mounting holes punched down both front rails.
    const holes = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.05, 0.02), dark, totalUnits * 3 * 2)
    let slot = 0
    for (let i = 0; i < totalUnits * 3; i++) {
      for (const sx of [-1, 1]) {
        this.matrix.makeTranslation((sx * (RACK_W - FRAME)) / 2, FRAME + (i + 0.5) * (UNIT_H / 3), RACK_D / 2 + 0.001)
        holes.setMatrixAt(slot++, this.matrix)
      }
    }
    group.add(holes)

    // Right side: an upper vented panel leaves the server sides visible so heat glow reads from outside.
    const sideX = RACK_W / 2 - 0.02
    const ventCount = 5
    for (let i = 0; i < ventCount; i++) {
      this.add(group, new THREE.BoxGeometry(0.04, 0.05, RACK_D - FRAME * 2.6), steel, sideX, height - FRAME - 0.12 - i * 0.14, 0)
    }

    const servers = this.buildServers(group, x, index, { bezel, dark, light })
    const drives = this.buildDrives(group, bezel, light, servers)
    const linkLeds = this.buildNetwork(group, { bezel, dark, light })
    this.buildPower(group, { bezel, dark, light })
    const storageLeds = this.isPreview ? null : this.buildStorage(group, { bezel, dark, light })
    this.buildCabling(group, index)
    this.buildPdu(group, dark)
    const door = index === 0 ? this.buildDoor(group, steel, index) : null
    this.buildRouter(group, dark)

    // Roof exhaust fans.
    const fans: THREE.Group[] = []
    const shroudMaterial = new THREE.MeshStandardMaterial({
      color: palette.steelDark,
      metalness: 0.5,
      roughness: 0.5,
      side: THREE.DoubleSide,
    })
    const blade = new THREE.BoxGeometry(1.04, 0.03, 0.2)
    for (let f = 0; f < 2; f++) {
      const fx = (f - 0.5) * RACK_W * 0.46
      this.add(group, new THREE.CylinderGeometry(0.62, 0.62, 0.18, 24, 1, true), shroudMaterial, fx, height + 0.09, 0)
      this.add(group, new THREE.CylinderGeometry(0.14, 0.14, 0.2, 12), dark, fx, height + 0.1, 0)
      const fan = new THREE.Group()
      fan.position.set(fx, height + 0.1, 0)
      fan.rotation.x = Math.PI / 2
      group.add(fan)
      for (let b = 0; b < 3; b++) this.add(fan, blade, light, 0, 0, 0).rotation.z = (b * Math.PI) / 3
      // Finger guard.
      for (let ring = 1; ring <= 2; ring++) {
        const guard = this.add(group, new THREE.TorusGeometry(0.2 * ring + 0.08, 0.012, 5, 24), light, fx, height + 0.19, 0)
        guard.rotation.x = Math.PI / 2
      }
      fans.push(fan)
    }

    // Everything added straight to the cabinet so far is static: collapse it to one mesh per material.
    mergeStaticMeshes(group)

    const air = (color: number) => {
      const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, depthWrite: false })
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, STREAKS)
      mesh.frustumCulled = false
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      group.add(mesh)
      return { mesh, material }
    }
    const hotAir = air(palette.red)
    const coldAir = air(palette.cyan)

    return {
      x,
      servers,
      caddies: drives.caddies,
      handles: drives.handles,
      storageLeds,
      door,
      doorOpen: true,
      fans,
      driveLeds: drives.driveLeds,
      linkLeds,
      hotAir: hotAir.mesh,
      hotAirMaterial: hotAir.material,
      coldAir: coldAir.mesh,
      coldAirMaterial: coldAir.material,
    }
  }

  /** Height of the middle of server slot u. */
  private serverY(u: number): number {
    return this.slotY(this.baseUnits + u)
  }

  /** Height of the middle of rack slot i, counted from the bottom. */
  private slotY(slot: number): number {
    return FRAME + UNIT_H * (slot + 0.5)
  }

  private buildServers(
    group: THREE.Group,
    rackX: number,
    index: number,
    materials: Record<'bezel' | 'dark' | 'light', THREE.Material>,
  ): ServerVisual[] {
    const { bezel, dark, light } = materials
    const servers: ServerVisual[] = []
    const chassisGeo = new THREE.BoxGeometry(FACE_W, UNIT_H - 0.08, RACK_D - FRAME * 2)
    const bezelGeo = new THREE.BoxGeometry(FACE_W, UNIT_H - 0.12, 0.05)
    const earGeo = new THREE.BoxGeometry(0.13, UNIT_H - 0.1, 0.08)
    const lampGeo = new THREE.SphereGeometry(0.055, 10, 8)
    const buttonGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.03, 12)
    buttonGeo.rotateX(Math.PI / 2)
    const barGeo = new THREE.BoxGeometry(0.42, 0.04, 0.03)
    const ventGeo = new THREE.BoxGeometry(0.5, 0.3, 0.02)
    const slatGeo = new THREE.BoxGeometry(0.5, 0.022, 0.03)
    const portGeo = new THREE.BoxGeometry(0.1, 0.09, 0.03)
    const tagGeo = new THREE.BoxGeometry(0.2, 0.07, 0.01)
    const hitGeo = new THREE.BoxGeometry(RACK_W, UNIT_H, RACK_D)
    const tag = new THREE.MeshStandardMaterial({ color: palette.white, roughness: 0.7 })
    const invisible = new THREE.MeshBasicMaterial({ visible: false })

    const black = new THREE.MeshStandardMaterial({ color: 0x101317, metalness: 0.35, roughness: 0.65 })
    const silver = new THREE.MeshStandardMaterial({ color: 0x8d99a6, metalness: 0.65, roughness: 0.4 })
    const gpuAccent = new THREE.MeshStandardMaterial({ color: 0x0c200a, emissive: 0x7dff6a, emissiveIntensity: 1.1 })
    const bladeAccent = new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.6 })
    const storageLamp = new THREE.MeshStandardMaterial({ color: 0x061420, emissive: palette.cyan, emissiveIntensity: 1.2 })
    const sledGeo = new THREE.BoxGeometry(0.2, 0.32, 0.04)
    const pullGeo = new THREE.BoxGeometry(0.03, 0.2, 0.03)
    const narrowGeo = new THREE.BoxGeometry(0.17, 0.3, 0.04)
    const dotGeo = new THREE.BoxGeometry(0.035, 0.035, 0.02)
    const stripGeo = new THREE.BoxGeometry(1.5, 0.03, 0.02)
    const fanGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.02, 20)
    fanGeo.rotateX(Math.PI / 2)
    const fanRingGeo = new THREE.TorusGeometry(0.17, 0.015, 5, 20)
    const fanBarGeo = new THREE.BoxGeometry(0.34, 0.025, 0.03)
    const shared = [chassisGeo, bezelGeo, earGeo, lampGeo, buttonGeo, barGeo, ventGeo, slatGeo, portGeo, tagGeo, sledGeo, pullGeo, narrowGeo, dotGeo, stripGeo, fanGeo, fanRingGeo, fanBarGeo]

    for (let u = 0; u < this.units; u++) {
      const node = this.logic.nodes[index * this.units + u]
      const y = this.serverY(u)
      const unit = new THREE.Group()
      unit.position.y = y
      group.add(unit)
      const roll = this.fx.next()
      const kind: ServerKind = roll < 0.4 ? 'compute' : roll < 0.6 ? 'storage' : roll < 0.8 ? 'gpu' : 'blade'

      // Static panel parts are merged per material, so a server costs a handful of draw calls.
      const batches = new Map<THREE.Material, THREE.BufferGeometry[]>()
      const put = (material: THREE.Material, geometry: THREE.BufferGeometry, x: number, py: number, z: number, turn = 0) => {
        const copy = geometry.clone()
        if (turn !== 0) copy.rotateZ(turn)
        copy.translate(x, py, z)
        const list = batches.get(material) ?? []
        list.push(copy)
        batches.set(material, list)
      }

      const face = kind === 'gpu' ? black : kind === 'compute' ? bezel : silver
      put(face, bezelGeo, 0, 0, FACE_Z)
      // Rack ears with a handle on each side.
      for (const side of [-1, 1]) put(light, earGeo, side * (FACE_W / 2 - 0.065), 0, FACE_Z + 0.02)

      if (kind === 'compute') {
        // Six drive bays (instanced per rack), then an intake vent with slats.
        put(dark, ventGeo, 0.62, 0, FACE_Z + 0.02)
        for (let i = 0; i < 4; i++) put(bezel, slatGeo, 0.62, -0.11 + i * 0.075, FACE_Z + 0.035)
      } else if (kind === 'storage') {
        // Drive bays all the way across: the six instanced ones plus three narrow ones.
        for (let i = 0; i < 3; i++) {
          const x = 0.42 + i * 0.2
          put(bezel, narrowGeo, x, 0, FACE_Z + 0.03)
          put(light, pullGeo, x - 0.05, 0, FACE_Z + 0.055)
          put(storageLamp, dotGeo, x + 0.04, 0.1, FACE_Z + 0.055)
        }
      } else if (kind === 'gpu') {
        // Three cooling fans behind grilles and a lit accent strip.
        for (let i = 0; i < 3; i++) {
          const x = -1.2 + i * 0.5
          put(dark, fanGeo, x, 0, FACE_Z + 0.03)
          put(light, fanRingGeo, x, 0, FACE_Z + 0.04)
          put(light, fanBarGeo, x, 0, FACE_Z + 0.045, Math.PI / 4)
          put(light, fanBarGeo, x, 0, FACE_Z + 0.045, -Math.PI / 4)
        }
        put(gpuAccent, stripGeo, 0.1, -0.15, FACE_Z + 0.03)
        put(dark, ventGeo, 0.62, 0.03, FACE_Z + 0.02)
      } else {
        // A row of vertical compute sleds, each with its own pull tab.
        for (let i = 0; i < 9; i++) {
          const x = -1.36 + i * 0.26
          put(i % 2 === 0 ? dark : bezel, sledGeo, x, 0, FACE_Z + 0.03)
          put(light, pullGeo, x, -0.02, FACE_Z + 0.055)
        }
        put(bladeAccent, stripGeo, -0.35, 0.185, FACE_Z + 0.03)
      }

      put(tag, tagGeo, 1.02, 0.08, FACE_Z + 0.03)
      put(dark, buttonGeo, 1.2, 0.08, FACE_Z + 0.035)
      // Network port the patch lead plugs into.
      put(dark, portGeo, 1.3, -0.09, FACE_Z + 0.03)

      for (const [material, list] of batches) {
        unit.add(new THREE.Mesh(mergeGeometries(list), material))
        for (const geometry of list) geometry.dispose()
      }

      // Per-node materials: these change color with the node's state.
      const chassis = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.55, roughness: 0.5 })
      this.add(unit, chassisGeo.clone(), chassis, 0, 0, 0)
      const activity = new THREE.MeshStandardMaterial({ color: 0x0b1a14, emissive: palette.cyan, emissiveIntensity: 0.2 })
      this.add(unit, barGeo.clone(), activity, 1.12, -0.1, FACE_Z + 0.03)
      const statusLamp = new THREE.MeshStandardMaterial({ color: 0x0b0d10, emissive: palette.green, emissiveIntensity: 1 })
      this.add(unit, lampGeo.clone(), statusLamp, 1.3, 0.08, FACE_Z + 0.03)

      // Invisible target spanning the slot, for hover and click.
      const hit = this.add(this.world, hitGeo, invisible, rackX, y + LIFT, 0)
      hit.userData.nodeId = node.id
      this.hitTargets.push(hit)

      const visual = { node, kind, rack: index, unit: u, group: unit, slide: 0, chassis, statusLamp, activity }
      servers.push(visual)
      this.servers.push(visual)
    }
    // The templates were only ever cloned.
    for (const geometry of shared) geometry.dispose()
    return servers
  }

  /** Hot-swap drive caddies and their LEDs, instanced across every server in the rack. */
  private buildDrives(group: THREE.Group, bezel: THREE.Material, light: THREE.Material, servers: ServerVisual[]) {
    const count = this.units * DRIVES
    const caddies = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 0.3, 0.04), bezel, count)
    const handles = new THREE.InstancedMesh(new THREE.BoxGeometry(0.03, 0.24, 0.02), light, count)
    const driveLeds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.035, 0.035, 0.02), new THREE.MeshBasicMaterial(), count)
    for (let i = 0; i < count; i++) driveLeds.setColorAt(i, ledOff)
    group.add(caddies, handles, driveLeds)
    const drives = { caddies, handles, driveLeds }
    for (const server of servers) this.placeDrives(drives, server, 0)
    return drives
  }

  /** Positions one server's drive instances; called again as the server slides out. */
  private placeDrives(
    drives: Pick<RackVisual, 'caddies' | 'handles' | 'driveLeds'>,
    server: ServerVisual,
    slide: number,
  ): void {
    const y = this.serverY(server.unit)
    // Only compute and storage nodes have front drive bays; the rest hide theirs.
    const size = server.kind === 'compute' || server.kind === 'storage' ? 1 : 0
    this.scale.setScalar(size)
    this.quaternion.identity()
    for (let d = 0; d < DRIVES; d++) {
      const slot = server.unit * DRIVES + d
      const dx = -FACE_W / 2 + 0.32 + d * 0.29
      this.matrix.compose(this.position.set(dx, y, FACE_Z + 0.03 + slide), this.quaternion, this.scale)
      drives.caddies.setMatrixAt(slot, this.matrix)
      this.matrix.compose(this.position.set(dx - 0.08, y, FACE_Z + 0.055 + slide), this.quaternion, this.scale)
      drives.handles.setMatrixAt(slot, this.matrix)
      this.matrix.compose(this.position.set(dx + 0.07, y + 0.1, FACE_Z + 0.055 + slide), this.quaternion, this.scale)
      drives.driveLeds.setMatrixAt(slot, this.matrix)
    }
    drives.caddies.instanceMatrix.needsUpdate = true
    drives.handles.instanceMatrix.needsUpdate = true
    drives.driveLeds.instanceMatrix.needsUpdate = true
  }

  /** Top of rack: firewall, network switch with link LEDs, and a patch panel jumpered to it. */
  private buildNetwork(group: THREE.Group, materials: Record<'bezel' | 'dark' | 'light', THREE.Material>): THREE.InstancedMesh {
    const { bezel, dark, light } = materials
    const firewallY = this.serverY(this.units)
    const switchY = this.serverY(this.units + 1)
    const patchY = this.serverY(this.units + 2)
    const unitGeo = new THREE.BoxGeometry(FACE_W, UNIT_H - 0.1, 0.6)
    this.add(group, unitGeo, new THREE.MeshStandardMaterial({ color: 0x9c2f2a, metalness: 0.35, roughness: 0.5 }), 0, firewallY, FACE_Z - 0.28)
    this.add(group, unitGeo, new THREE.MeshStandardMaterial({ color: 0x24303a, metalness: 0.4, roughness: 0.55 }), 0, switchY, FACE_Z - 0.28)
    this.add(group, unitGeo, bezel, 0, patchY, FACE_Z - 0.28)

    // Firewall: status display, a few ports and a row of indicator lamps.
    this.add(
      group,
      new THREE.BoxGeometry(0.5, 0.18, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x1a0806, emissive: palette.amber, emissiveIntensity: 1 }),
      -FACE_W / 2 + 0.5,
      firewallY,
      FACE_Z + 0.03,
    )
    for (let i = 0; i < 4; i++) this.add(group, new THREE.BoxGeometry(0.11, 0.1, 0.03), dark, 0.5 + i * 0.16, firewallY, FACE_Z + 0.03)
    const lamp = new THREE.MeshStandardMaterial({ color: 0x06140f, emissive: palette.green, emissiveIntensity: 1.3 })
    for (let i = 0; i < 5; i++) this.add(group, new THREE.BoxGeometry(0.04, 0.04, 0.02), lamp, -0.3 + i * 0.09, firewallY + 0.06, FACE_Z + 0.03)

    const ports = new THREE.InstancedMesh(new THREE.BoxGeometry(0.11, 0.1, 0.03), dark, PORTS * 2)
    const linkLeds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.025, 0.02), new THREE.MeshBasicMaterial(), PORTS)
    for (let p = 0; p < PORTS; p++) {
      const px = this.portX(p)
      this.matrix.makeTranslation(px, switchY - 0.04, FACE_Z + 0.03)
      ports.setMatrixAt(p, this.matrix)
      this.matrix.makeTranslation(px, patchY, FACE_Z + 0.03)
      ports.setMatrixAt(PORTS + p, this.matrix)
      this.matrix.makeTranslation(px, switchY + 0.09, FACE_Z + 0.03)
      linkLeds.setMatrixAt(p, this.matrix)
      linkLeds.setColorAt(p, ledOff)
    }
    group.add(ports, linkLeds)
    this.add(group, new THREE.BoxGeometry(PORTS * 0.16, 0.03, 0.01), light, this.portX((PORTS - 1) / 2), patchY + 0.13, FACE_Z + 0.03)
    this.add(
      group,
      new THREE.BoxGeometry(0.3, 0.16, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x062018, emissive: palette.green, emissiveIntensity: 0.9 }),
      FACE_W / 2 - 0.4,
      switchY,
      FACE_Z + 0.03,
    )

    // Blue jumpers loop from each patch-panel port down to the switch port below it.
    const jumper = new THREE.MeshStandardMaterial({ color: CABLE_BLUE, roughness: 0.55 })
    for (let p = 0; p < PORTS; p++) {
      const px = this.portX(p)
      const bulge = 0.2 + ((p * 7) % 5) * 0.025
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(px, patchY, FACE_Z + 0.04),
        new THREE.Vector3(px + 0.02, patchY - 0.1, FACE_Z + bulge),
        new THREE.Vector3(px - 0.02, switchY + 0.12, FACE_Z + bulge),
        new THREE.Vector3(px, switchY - 0.02, FACE_Z + 0.04),
      ])
      this.add(group, new THREE.TubeGeometry(curve, 14, 0.02, 5), jumper, 0, 0, 0)
    }
    return linkLeds
  }

  private portX(port: number): number {
    return -FACE_W / 2 + 0.32 + port * 0.16
  }

  /** Bottom of rack: a 1U power distribution unit and a 2U uninterruptible power supply. */
  private buildPower(group: THREE.Group, materials: Record<'bezel' | 'dark' | 'light', THREE.Material>): void {
    const { bezel, dark } = materials
    // PDU: breaker switch and a row of outlets.
    const pduY = this.slotY(0)
    this.add(group, new THREE.BoxGeometry(FACE_W, UNIT_H - 0.1, 0.7), dark, 0, pduY, FACE_Z - 0.33)
    this.add(
      group,
      new THREE.BoxGeometry(0.16, 0.2, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x400a08, emissive: palette.red, emissiveIntensity: 1.6 }),
      -FACE_W / 2 + 0.3,
      pduY,
      FACE_Z + 0.03,
    )
    const outlets = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.2, 0.03), bezel, 8)
    for (let i = 0; i < 8; i++) {
      this.matrix.makeTranslation(-FACE_W / 2 + 0.72 + i * 0.3, pduY, FACE_Z + 0.03)
      outlets.setMatrixAt(i, this.matrix)
    }
    group.add(outlets)

    const y = (this.slotY(1) + this.slotY(2)) / 2
    this.add(group, new THREE.BoxGeometry(FACE_W, UNIT_H * 2 - 0.08, RACK_D - FRAME * 2), bezel, 0, y, 0)
    this.add(group, new THREE.BoxGeometry(FACE_W * 0.5, UNIT_H * 1.4, 0.02), dark, -FACE_W * 0.2, y, FACE_Z + 0.03)
    for (let i = 0; i < 7; i++) this.add(group, new THREE.BoxGeometry(FACE_W * 0.5, 0.025, 0.03), bezel, -FACE_W * 0.2, y - 0.3 + i * 0.1, FACE_Z + 0.04)
    this.add(group, new THREE.BoxGeometry(FACE_W, 0.06, 0.03), new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.6 }), 0, y + UNIT_H - 0.1, FACE_Z + 0.03)
    this.add(
      group,
      new THREE.BoxGeometry(0.5, 0.26, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x061420, emissive: palette.cyan, emissiveIntensity: 1.1 }),
      FACE_W * 0.26,
      y + 0.05,
      FACE_Z + 0.03,
    )
    // Battery level segments.
    const segment = new THREE.MeshStandardMaterial({ color: 0x06140f, emissive: palette.green, emissiveIntensity: 1.4 })
    for (let i = 0; i < 5; i++) this.add(group, new THREE.BoxGeometry(0.07, 0.07, 0.02), segment, FACE_W * 0.12 + i * 0.1, y - 0.2, FACE_Z + 0.03)
  }

  /** A 2U storage shelf between the UPS and the servers: twelve drive bays with activity LEDs. */
  private buildStorage(group: THREE.Group, materials: Record<'bezel' | 'dark' | 'light', THREE.Material>): THREE.InstancedMesh {
    const { bezel, dark, light } = materials
    const y = (this.slotY(3) + this.slotY(4)) / 2
    this.add(group, new THREE.BoxGeometry(FACE_W, UNIT_H * 2 - 0.08, RACK_D - FRAME * 2), dark, 0, y, 0)
    for (const side of [-1, 1]) this.add(group, new THREE.BoxGeometry(0.13, UNIT_H * 2 - 0.12, 0.08), light, side * (FACE_W / 2 - 0.065), y, FACE_Z + 0.02)
    const bays = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.38, 0.04), bezel, BAYS)
    const pulls = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.04, 0.03), light, BAYS)
    const leds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.04, 0.04, 0.02), new THREE.MeshBasicMaterial(), BAYS)
    for (let b = 0; b < BAYS; b++) {
      const bx = -FACE_W / 2 + 0.48 + (b % 6) * 0.46
      const by = y + (b < 6 ? 0.21 : -0.21)
      this.matrix.makeTranslation(bx, by, FACE_Z + 0.03)
      bays.setMatrixAt(b, this.matrix)
      this.matrix.makeTranslation(bx, by - 0.12, FACE_Z + 0.055)
      pulls.setMatrixAt(b, this.matrix)
      this.matrix.makeTranslation(bx + 0.15, by + 0.13, FACE_Z + 0.055)
      leds.setMatrixAt(b, this.matrix)
      leds.setColorAt(b, ledOff)
    }
    group.add(bays, pulls, leds)
    return leds
  }

  /**
   * Front cabling, dressed like a hand-built rack: warm-colored patch leads run
   * from each server up a manager on the right rail to the switch, and blue
   * management leads drop down the left rail.
   */
  private buildCabling(group: THREE.Group, index: number): void {
    const trunkX = FACE_W / 2 + 0.07
    const trunkZ = FACE_Z + 0.22
    const switchY = this.serverY(this.units + 1) - 0.04
    const leads = leadColors.map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.55 }))
    const blue = new THREE.MeshStandardMaterial({ color: CABLE_BLUE, roughness: 0.55 })
    const bottomY = this.slotY(this.baseUnits - 1)
    for (let u = 0; u < this.units; u++) {
      const y = this.serverY(u) - 0.09
      // Each lead keeps its own lane in the bundle so cables stay distinct.
      const lane = (u / this.units - 0.5) * 0.14
      const port = this.portX(PORTS - 1 - u)
      const right = new THREE.CatmullRomCurve3([
        new THREE.Vector3(1.3, y, FACE_Z + 0.04),
        new THREE.Vector3(1.4, y + 0.02, FACE_Z + 0.2),
        new THREE.Vector3(trunkX + lane, y + 0.28, trunkZ + lane),
        new THREE.Vector3(trunkX + lane, switchY - 0.5, trunkZ + lane),
        new THREE.Vector3(port + 0.25, switchY - 0.3, FACE_Z + 0.3),
        new THREE.Vector3(port, switchY - 0.12, FACE_Z + 0.16),
        new THREE.Vector3(port, switchY, FACE_Z + 0.04),
      ])
      this.add(group, new THREE.TubeGeometry(right, 44, 0.022, 5), leads[(u + index) % leads.length], 0, 0, 0)

      const left = new THREE.CatmullRomCurve3([
        new THREE.Vector3(-FACE_W / 2 + 0.16, y + 0.09, FACE_Z + 0.06),
        new THREE.Vector3(-FACE_W / 2 + 0.02, y + 0.1, FACE_Z + 0.22),
        new THREE.Vector3(-trunkX - lane, y - 0.2, trunkZ + lane),
        new THREE.Vector3(-trunkX - lane, bottomY + 0.3, trunkZ + lane),
        new THREE.Vector3(-trunkX + 0.3 + u * 0.05, bottomY, FACE_Z + 0.12),
        new THREE.Vector3(-FACE_W / 2 + 0.5 + u * 0.1, bottomY - 0.06, FACE_Z + 0.04),
      ])
      this.add(group, new THREE.TubeGeometry(left, 36, 0.02, 5), blue, 0, 0, 0)
    }
    // Cable manager rings on both rails.
    const ring = new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.7 })
    const ringGeo = new THREE.TorusGeometry(0.14, 0.016, 5, 14)
    for (let i = 0; i < 5; i++) {
      const y = this.serverY(0) + ((this.serverY(this.units) - this.serverY(0)) * (i + 0.5)) / 5
      for (const side of [-1, 1]) this.add(group, ringGeo, ring, side * trunkX, y, trunkZ).rotation.x = Math.PI / 2
    }
  }

  /** Vertical power strip on the right rear rail, with an outlet LED per server. */
  private buildPdu(group: THREE.Group, dark: THREE.Material): void {
    const length = this.units * UNIT_H
    const centerY = (this.serverY(0) + this.serverY(this.units - 1)) / 2
    const x = RACK_W / 2 + 0.05
    const z = -RACK_D / 2 + 0.45
    this.add(group, new THREE.BoxGeometry(0.1, length, 0.3), dark, x, centerY, z)
    const outlet = new THREE.MeshStandardMaterial({ color: 0x06140f, emissive: palette.green, emissiveIntensity: 1.2 })
    const leds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.02, 0.05, 0.05), outlet, this.units)
    for (let u = 0; u < this.units; u++) {
      this.matrix.makeTranslation(x + 0.05, this.serverY(u), z)
      leds.setMatrixAt(u, this.matrix)
    }
    group.add(leds)
    this.add(
      group,
      new THREE.BoxGeometry(0.02, 0.22, 0.2),
      new THREE.MeshStandardMaterial({ color: 0x1a1206, emissive: palette.amber, emissiveIntensity: 1.2 }),
      x + 0.05,
      centerY + length / 2 + 0.2,
      z,
    )
  }

  /** Perforated mesh front door on a left hinge. Clicking it swings it open or shut. */
  private buildDoor(group: THREE.Group, steel: THREE.Material, index: number): THREE.Group {
    const height = this.rackHeight - FRAME
    const door = new THREE.Group()
    door.position.set(-RACK_W / 2, FRAME / 2, RACK_D / 2 + 0.06)
    door.rotation.y = DOOR_OPEN
    group.add(door)
    const rail = 0.1
    this.add(door, new THREE.BoxGeometry(rail, height, 0.05), steel, rail / 2, height / 2, 0)
    this.add(door, new THREE.BoxGeometry(rail, height, 0.05), steel, RACK_W - rail / 2, height / 2, 0)
    this.add(door, new THREE.BoxGeometry(RACK_W, rail, 0.05), steel, RACK_W / 2, rail / 2, 0)
    this.add(door, new THREE.BoxGeometry(RACK_W, rail, 0.05), steel, RACK_W / 2, height - rail / 2, 0)

    // Punched-hole mesh as an alpha cutout, so the rack stays visible through a closed door.
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 32
    const context = canvas.getContext('2d')!
    context.fillStyle = '#39424c'
    context.fillRect(0, 0, 32, 32)
    context.globalCompositeOperation = 'destination-out'
    for (const [cx, cy] of [[8, 8], [24, 24]]) {
      context.beginPath()
      context.arc(cx, cy, 6.4, 0, Math.PI * 2)
      context.fill()
    }
    const mesh = new THREE.CanvasTexture(canvas)
    mesh.wrapS = mesh.wrapT = THREE.RepeatWrapping
    mesh.repeat.set(RACK_W * 5, height * 5)
    mesh.colorSpace = THREE.SRGBColorSpace
    this.add(
      door,
      new THREE.PlaneGeometry(RACK_W - rail * 2, height - rail * 2),
      new THREE.MeshStandardMaterial({ map: mesh, alphaTest: 0.5, side: THREE.DoubleSide, metalness: 0.5, roughness: 0.5 }),
      RACK_W / 2,
      height / 2,
      0,
    )
    this.add(door, new THREE.BoxGeometry(0.06, 0.5, 0.08), new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.8, roughness: 0.3 }), RACK_W - 0.2, height / 2, 0.05)

    const hit = this.add(door, new THREE.BoxGeometry(RACK_W, height, 0.12), new THREE.MeshBasicMaterial({ visible: false }), RACK_W / 2, height / 2, 0)
    hit.userData.door = index
    this.hitTargets.push(hit)
    return door
  }

  /** Wireless router on the roof, between the fans. */
  private buildRouter(group: THREE.Group, dark: THREE.Material): void {
    const y = this.rackHeight
    const z = RACK_D / 2 - 0.5
    this.add(group, new THREE.BoxGeometry(0.9, 0.12, 0.5), dark, 0, y + 0.06, z)
    const antenna = new THREE.CylinderGeometry(0.02, 0.025, 0.7, 6)
    antenna.translate(0, 0.35, 0)
    for (const [x, tilt] of [[-0.38, 0.45], [0, 0], [0.38, -0.45]]) this.add(group, antenna, dark, x, y + 0.1, z - 0.2).rotation.z = tilt
    this.add(group, new THREE.BoxGeometry(0.3, 0.02, 0.02), new THREE.MeshStandardMaterial({ color: 0x06140f, emissive: palette.green, emissiveIntensity: 1.4 }), 0, y + 0.07, z + 0.25)
  }

  /** Raised-floor tile seams, and a perforated cold-air tile in front of each rack. */
  private buildFloor(width: number, depth: number): void {
    const tile = 1.2
    const points: number[] = []
    const z0 = 1.2 - depth / 2
    for (let x = -width / 2 + tile; x < width / 2; x += tile) points.push(x, 0.004, z0, x, 0.004, z0 + depth)
    for (let z = z0 + tile; z < z0 + depth; z += tile) points.push(-width / 2, 0.004, z, width / 2, 0.004, z)
    const seams = new THREE.BufferGeometry()
    seams.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
    this.world.add(new THREE.LineSegments(seams, new THREE.LineBasicMaterial({ color: 0x2a323b })))

    const rackCount = this.isPreview ? 1 : 2
    const grate = new THREE.MeshStandardMaterial({ color: 0x0c1418, emissive: palette.cyan, emissiveIntensity: 0.12, roughness: 0.8 })
    const slot = new THREE.MeshStandardMaterial({ color: 0x06090c, roughness: 0.9 })
    for (let r = 0; r < rackCount; r++) {
      const x = (r - (rackCount - 1) / 2) * (RACK_W + RACK_GAP)
      this.add(this.world, new THREE.BoxGeometry(RACK_W * 0.9, 0.02, 1), grate, x, 0.011, RACK_D / 2 + 0.9)
      const slots = new THREE.InstancedMesh(new THREE.BoxGeometry(0.34, 0.012, 0.05), slot, 7 * 8)
      let i = 0
      for (let col = 0; col < 7; col++) {
        for (let row = 0; row < 8; row++) {
          this.matrix.makeTranslation(x + (col - 3) * 0.44, 0.024, RACK_D / 2 + 0.5 + row * 0.115)
          slots.setMatrixAt(i++, this.matrix)
        }
      }
      this.world.add(slots)
    }
  }

  /** Room cooling unit beside the racks; its light and fan follow the Cooling control. */
  private buildCooler(x: number, steel: THREE.Material): void {
    const height = this.rackHeight * 0.82
    const shell = new THREE.MeshStandardMaterial({ color: 0x8794a1, metalness: 0.35, roughness: 0.5 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.8 })
    this.add(this.world, new THREE.BoxGeometry(2, height, 2.2), shell, x, height / 2, -0.2)
    this.add(this.world, new THREE.BoxGeometry(1.6, height * 0.34, 0.03), dark, x, height * 0.24, 0.91)
    for (let i = 0; i < 8; i++) {
      this.add(this.world, new THREE.BoxGeometry(1.6, 0.03, 0.05), shell, x, height * 0.09 + i * height * 0.042, 0.93)
    }
    this.coolingStrip = new THREE.MeshStandardMaterial({ color: 0x0c2a36, emissive: palette.cyan, emissiveIntensity: 1 })
    this.add(this.world, new THREE.BoxGeometry(1.6, 0.07, 0.03), this.coolingStrip, x, height * 0.52, 0.92)
    this.add(this.world, new THREE.BoxGeometry(0.5, 0.3, 0.03), new THREE.MeshStandardMaterial({ color: 0x06140f, emissive: palette.cyan, emissiveIntensity: 0.9 }), x - 0.5, height * 0.68, 0.92)

    // Top-mounted blower.
    const shroud = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.5, roughness: 0.5, side: THREE.DoubleSide })
    this.add(this.world, new THREE.CylinderGeometry(0.75, 0.75, 0.2, 24, 1, true), shroud, x, height + 0.1, -0.2)
    this.coolerFan = new THREE.Group()
    this.coolerFan.position.set(x, height + 0.1, -0.2)
    this.coolerFan.rotation.x = Math.PI / 2
    this.world.add(this.coolerFan)
    for (let b = 0; b < 4; b++) this.add(this.coolerFan, new THREE.BoxGeometry(1.3, 0.03, 0.24), steel, 0, 0, 0).rotation.z = (b * Math.PI) / 4
    // Chilled-water pipes running back from the unit.
    const pipe = new THREE.CylinderGeometry(0.09, 0.09, 1.4, 10)
    pipe.rotateX(Math.PI / 2)
    this.add(this.world, pipe, new THREE.MeshStandardMaterial({ color: palette.cyan, metalness: 0.4, roughness: 0.5 }), x - 0.4, 0.3, -1.9)
    this.add(this.world, pipe, new THREE.MeshStandardMaterial({ color: palette.red, metalness: 0.4, roughness: 0.5 }), x + 0.1, 0.3, -1.9)
  }

  /** Monitor above and behind the racks, graphing rack power against the PDU cap. */
  private buildDisplay(spanX: number, steel: THREE.Material): void {
    const canvas = document.createElement('canvas')
    canvas.width = 384
    canvas.height = 192
    const context = canvas.getContext('2d')!
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    this.display = { texture, context }

    const width = Math.min(spanX + 0.6, 6.4)
    const height = width * 0.5
    const y = this.rackHeight + 0.5 + height / 2
    const z = -RACK_D / 2 - 0.9
    this.add(this.world, new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }), 0, y, z)
    this.add(this.world, new THREE.BoxGeometry(width + 0.2, height + 0.2, 0.1), steel, 0, y, z - 0.06)
    for (const side of [-1, 1]) {
      this.add(this.world, new THREE.BoxGeometry(0.14, y, 0.14), steel, side * (width / 2 - 0.3), y / 2, z - 0.12)
    }
    this.drawDisplay()
  }

  private drawDisplay(): void {
    if (!this.display) return
    const { context: g, texture } = this.display
    const w = g.canvas.width
    const h = g.canvas.height
    const top = 52
    const bottom = h - 10
    g.fillStyle = '#070a0d'
    g.fillRect(0, 0, w, h)

    g.strokeStyle = '#1d252e'
    g.lineWidth = 1
    for (let i = 0; i <= 4; i++) {
      const y = top + ((bottom - top) * i) / 4
      g.beginPath()
      g.moveTo(0, y)
      g.lineTo(w, y)
      g.stroke()
    }

    // PDU cap: the top of the plot.
    g.strokeStyle = '#ff5a4f'
    g.setLineDash([6, 4])
    g.beginPath()
    g.moveTo(0, top)
    g.lineTo(w, top)
    g.stroke()
    g.setLineDash([])

    const cap = this.num('powerCap')
    const plot = (key: 'power' | 'util', scale: number, color: string, lineWidth: number) => {
      g.strokeStyle = color
      g.lineWidth = lineWidth
      g.beginPath()
      this.history.forEach((sample, i) => {
        const x = (i / (GRAPH_SAMPLES - 1)) * w
        const y = bottom - Math.min(1, sample[key] / scale) * (bottom - top)
        if (i === 0) g.moveTo(x, y)
        else g.lineTo(x, y)
      })
      g.stroke()
    }
    plot('util', 1, '#4cc9f0', 2)
    plot('power', cap, '#ffb020', 3)

    g.font = '600 28px "IBM Plex Mono", ui-monospace, monospace'
    g.fillStyle = '#ffb020'
    g.fillText(`${this.logic.totalPower.toFixed(1)} kW`, 12, 34)
    g.fillStyle = '#4cc9f0'
    g.fillText(`${(this.logic.utilization() * 100).toFixed(0)}%`, 170, 34)
    g.font = '500 16px "IBM Plex Mono", ui-monospace, monospace'
    g.fillStyle = '#ff5a4f'
    g.fillText(`CAP ${cap.toFixed(0)} kW`, w - 118, 30)
    texture.needsUpdate = true
  }

  /** Seeded room dressing: a crash cart, spare servers, an extinguisher and floor cable covers. */
  private buildDressing(spanX: number, steel: THREE.Material): void {
    const dark = new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.8 })
    const frontZ = RACK_D / 2 + 2.6

    // Crash cart: a rolling table with a console.
    const cartX = spanX / 2 + this.rng.range(1.5, 2.3)
    const cart = new THREE.Group()
    cart.position.set(cartX, 0, this.rng.range(0.6, 1.6))
    cart.rotation.y = this.rng.range(-0.5, -0.2)
    this.world.add(cart)
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) this.add(cart, new THREE.BoxGeometry(0.07, 1.5, 0.07), steel, sx * 0.55, 0.75, sz * 0.4)
    }
    this.add(cart, new THREE.BoxGeometry(1.3, 0.08, 1), steel, 0, 1.5, 0)
    this.add(cart, new THREE.BoxGeometry(1.3, 0.06, 1), steel, 0, 0.5, 0)
    this.add(cart, new THREE.BoxGeometry(0.9, 0.6, 0.06), dark, 0, 1.95, -0.3)
    this.add(
      cart,
      new THREE.BoxGeometry(0.8, 0.5, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x06140f, emissive: palette.green, emissiveIntensity: 0.8 }),
      0,
      1.95,
      -0.26,
    )
    this.add(cart, new THREE.BoxGeometry(0.1, 0.2, 0.1), dark, 0, 1.6, -0.3)
    this.add(cart, new THREE.BoxGeometry(0.8, 0.04, 0.3), dark, 0, 1.56, 0.2)

    // Spare servers stacked on the floor.
    const spare = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.55, roughness: 0.5 })
    const spares = this.rng.int(2, 4)
    const spareX = this.rng.range(-spanX / 2, spanX / 2 - 1)
    for (let i = 0; i < spares; i++) {
      this.add(this.world, new THREE.BoxGeometry(2.2, 0.3, 1.5), spare, spareX + this.rng.range(-0.06, 0.06), 0.15 + i * 0.32, frontZ + this.rng.range(-0.05, 0.05)).rotation.y =
        this.rng.range(-0.08, 0.08)
    }

    // Fire extinguisher.
    const extinguisherX = -spanX / 2 - this.rng.range(0.6, 1)
    this.add(this.world, new THREE.CylinderGeometry(0.16, 0.16, 0.8, 12), new THREE.MeshStandardMaterial({ color: palette.red, metalness: 0.3, roughness: 0.45 }), extinguisherX, 0.4, frontZ)
    this.add(this.world, new THREE.CylinderGeometry(0.05, 0.08, 0.16, 8), dark, extinguisherX, 0.88, frontZ)

    // Floor cable cover from the racks to the cart.
    const cover = new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.8 })
    this.add(this.world, new THREE.BoxGeometry(spanX / 2 + 2, 0.05, 0.22), cover, spanX / 4 + 1, 0.025, RACK_D / 2 + 1.75)
  }

  /** What the pointer is over: a server, a cabinet door, or nothing. */
  private pick(event: PointerEvent): THREE.Object3D | null {
    const element = this.ctx.element
    if (!element) return null
    const rect = element.getBoundingClientRect()
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(pointer, this.camera)
    return this.raycaster.intersectObjects(this.hitTargets, false)[0]?.object ?? null
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.pointerStart = { x: event.clientX, y: event.clientY }
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse' || event.buttons !== 0) return
    const target = this.pick(event)
    const element = this.ctx.element
    if (element) element.style.cursor = target ? 'pointer' : ''
    const visual = target ? this.servers[target.userData.nodeId as number] : undefined
    this.hoverFrame.visible = visual !== undefined && visual.node.id !== this.selected
    if (visual) this.hoverFrame.position.set(this.racks[visual.rack].x, this.serverY(visual.unit) + LIFT, visual.slide * SLIDE)
  }

  private onPointerLeave = (): void => {
    this.hoverFrame.visible = false
  }

  /**
   * A click (not a camera drag). On a door: swing it. On a crashed server:
   * restart it. On a server: pull it out to inspect it; clicking the
   * pulled-out server pushes it back in.
   */
  private onPointerUp = (event: PointerEvent): void => {
    const start = this.pointerStart
    this.pointerStart = null
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return
    const target = this.pick(event)
    if (!target) {
      this.selected = -1
      return
    }
    if (target.userData.door !== undefined) {
      const rack = this.racks[target.userData.door as number]
      rack.doorOpen = !rack.doorOpen
      this.events.emit({ type: 'door_toggle' })
      return
    }
    const id = target.userData.nodeId as number
    const node = this.logic.nodes[id]
    this.hoverFrame.visible = false
    if (node.status === 'down' && !node.held) {
      this.logic.reboot(id)
      this.selected = id
      this.events.emit({ type: 'server_reboot' })
    } else if (this.selected === id) {
      // Clicking the pulled-out server pushes it back in.
      this.selected = -1
      this.events.emit({ type: 'server_pushed' })
    } else {
      this.selected = id
      this.events.emit({ type: 'server_pulled' })
    }
  }
}
