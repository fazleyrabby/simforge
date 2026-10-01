import * as THREE from 'three'
import { makeIsoCamera } from '../../three/cameras'
import { palette } from '../../three/palette'
import { makePlinth } from '../../three/plinth'
import { BaseSimulation } from '../core/BaseSimulation'
import type { ParamValue, StatValue } from '../core/Simulation'
import { RackLogic, T_AMBIENT, T_CRIT, type RackParams, type ServerNode } from './RackLogic'

const UNIT_H = 0.5
const RACK_W = 3.6
const RACK_D = 2.8
const RACK_GAP = 1.8
const FRAME = 0.16
const BURST_JOBS = 60
/** Hot-air streaks drawn above each cabinet. */
const STREAKS = 16

const statusColor = {
  idle: new THREE.Color(palette.green),
  busy: new THREE.Color(palette.green),
  throttled: new THREE.Color(palette.amber),
  down: new THREE.Color(palette.red),
}
const warm = new THREE.Color(palette.amber)
const hot = new THREE.Color(palette.red)

/** Rendering-side counterpart of one logic node. */
interface ServerVisual {
  node: ServerNode
  chassis: THREE.MeshStandardMaterial
  statusLamp: THREE.MeshStandardMaterial
  activity: THREE.MeshStandardMaterial
}

interface RackVisual {
  x: number
  servers: ServerVisual[]
  fans: THREE.Group[]
  exhaust: THREE.InstancedMesh
  exhaustMaterial: THREE.MeshBasicMaterial
}

export default class RackSimulation extends BaseSimulation {
  private logic!: RackLogic
  private racks: RackVisual[] = []
  private hitTargets: THREE.Mesh[] = []
  private rackHeight = 5
  private display: { texture: THREE.CanvasTexture; context: CanvasRenderingContext2D } | null = null
  private history: { power: number; util: number }[] = []
  private sampleTimer = 0
  private drawTimer = 0
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
    const unitsPerRack = this.isPreview ? 8 : 10
    this.rackHeight = unitsPerRack * UNIT_H + FRAME * 2
    this.racks = []
    this.hitTargets = []
    this.history = []

    this.logic = new RackLogic(this.rng, rackCount * unitsPerRack, this.readParams())
    this.logic.onDown = (node) => {
      this.events.emit({
        type: 'node_down',
        level: 'warn',
        title: 'NODE DOWN',
        message: `Server ${this.nodeLabel(node.id)} overheated and dropped offline. Click it to restart, or add cooling.`,
      })
    }

    const spanX = rackCount * RACK_W + (rackCount - 1) * RACK_GAP
    this.world.add(makePlinth(spanX + 3.4, RACK_D + 3))

    const steel = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.6, roughness: 0.4 })
    for (let r = 0; r < rackCount; r++) {
      const x = (r - (rackCount - 1) / 2) * (RACK_W + RACK_GAP)
      this.racks.push(this.buildRack(x, unitsPerRack, r, steel))
    }

    this.buildDisplay(spanX)
    this.buildDressing(spanX)

    this.focus.set(0, this.rackHeight * 0.5, 0)
    this.enableShadows(this.world)
    this.lighting.setShadowExtent(spanX + 6)
    const halfW = spanX * 0.6 + 2.2
    const halfH = this.rackHeight * 0.62 + (this.isPreview ? 0.5 : 1.4)
    this.setView(halfW, halfH)

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
    this.display = null
  }

  protected update(dt: number): void {
    this.logic.step(dt)
    this.sampleTimer += dt
    if (this.sampleTimer >= 0.12) {
      this.sampleTimer = 0
      this.history.push({ power: this.logic.totalPower, util: this.logic.utilization() })
      if (this.history.length > 160) this.history.shift()
    }
  }

  render(_alpha: number): void {
    const blink = Math.sin(this.time * 16) > 0 ? 1 : 0.12
    for (const rack of this.racks) {
      let rackHeat = 0
      for (const visual of rack.servers) {
        const node = visual.node
        rackHeat = Math.max(rackHeat, this.heat(node.temp))
        this.paintServer(visual, blink)
      }
      // Exhaust fans spin with the cooling effort; hotter racks run harder.
      const fanSpeed = (0.6 + this.num('cooling') * 2.4) * (0.5 + rackHeat)
      for (const fan of rack.fans) fan.rotation.z += fanSpeed * 0.05
      this.paintExhaust(rack, rackHeat)
    }

    this.drawTimer += 1
    if (this.display && this.drawTimer >= 3) {
      this.drawTimer = 0
      this.drawDisplay()
    }
  }

  protected onParam(_key: string, _value: ParamValue): void {
    this.logic.params = this.readParams()
  }

  action(key: string): void {
    if (key !== 'burst') return
    this.logic.burst(BURST_JOBS)
    this.events.emit({
      type: 'traffic_burst',
      level: 'info',
      title: 'TRAFFIC BURST',
      message: `${BURST_JOBS} jobs injected. Watch the queue drain as nodes heat up.`,
    })
  }

  getStats(): Record<string, StatValue> {
    const { logic } = this
    return {
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

  private nodeLabel(id: number): string {
    const units = this.isPreview ? 8 : 10
    return `R${Math.floor(id / units) + 1}-U${(id % units) + 1}`
  }

  private paintServer(visual: ServerVisual, blink: number): void {
    const node = visual.node
    const h = this.heat(node.temp)

    // Chassis glows from amber to red as it heats; cool servers stay dark steel.
    if (node.status === 'down') {
      visual.chassis.emissive.setHex(0x000000)
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
      status === 'down' ? 2.2 * blink : status === 'idle' ? 0.35 : status === 'throttled' ? 1.8 : 1.4

    // Activity bar flickers with the number of in-flight jobs.
    const load = node.jobs.length / node.slots
    const flicker = node.status === 'down' ? 0 : load > 0 ? 0.5 + 0.5 * Math.sin(this.time * 30 + node.id * 2.3) : 0
    visual.activity.emissiveIntensity = load > 0 ? 0.6 + flicker * load * 1.6 : 0.05
  }

  private paintExhaust(rack: RackVisual, rackHeat: number): void {
    const mesh = rack.exhaust
    for (let i = 0; i < STREAKS; i++) {
      const seed = i * 1.37
      const phase = (this.time * (0.4 + this.num('cooling') * 0.5) + seed) % 1
      const y = this.rackHeight + 0.4 + phase * 1.8
      const fade = Math.sin(phase * Math.PI)
      const s = rackHeat * fade
      this.position.set(
        rack.x + (((seed * 7.1) % 1) - 0.5) * RACK_W * 0.7,
        y,
        -RACK_D * 0.1 + (((seed * 3.3) % 1) - 0.5) * RACK_D * 0.5,
      )
      this.scale.set(0.05 + s * 0.08, 0.3 + s * 0.6, 0.05 + s * 0.08)
      if (s < 0.02) this.scale.setScalar(0.0001)
      this.matrix.compose(this.position, this.quaternion, this.scale)
      mesh.setMatrixAt(i, this.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
    rack.exhaustMaterial.opacity = 0.14 + rackHeat * 0.4
  }

  private buildRack(x: number, units: number, index: number, steel: THREE.Material): RackVisual {
    const group = new THREE.Group()
    group.position.x = x
    this.world.add(group)

    const height = this.rackHeight
    // Four corner posts and a floor/roof plate form the cabinet.
    const postGeo = new THREE.BoxGeometry(FRAME, height, FRAME)
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, steel)
        post.position.set((sx * (RACK_W - FRAME)) / 2, height / 2, (sz * (RACK_D - FRAME)) / 2)
        group.add(post)
      }
    }
    for (const y of [FRAME / 2, height - FRAME / 2]) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(RACK_W, FRAME, RACK_D), steel)
      plate.position.set(0, y, 0)
      group.add(plate)
    }
    // Side and back panels close the cabinet in.
    const panelMat = new THREE.MeshStandardMaterial({ color: 0x14181d, metalness: 0.4, roughness: 0.6 })
    const back = new THREE.Mesh(new THREE.BoxGeometry(RACK_W - FRAME, height - FRAME * 2, 0.06), panelMat)
    back.position.set(0, height / 2, -RACK_D / 2 + FRAME / 2)
    group.add(back)

    const servers: ServerVisual[] = []
    const chassisGeo = new THREE.BoxGeometry(RACK_W - FRAME * 2.4, UNIT_H - 0.08, RACK_D - FRAME * 2)
    const lampGeo = new THREE.SphereGeometry(0.07, 10, 8)
    const barGeo = new THREE.BoxGeometry(RACK_W - FRAME * 3.4, 0.05, 0.04)
    for (let u = 0; u < units; u++) {
      const node = this.logic.nodes[index * units + u]
      const y = FRAME + UNIT_H * (u + 0.5)
      const faceZ = RACK_D / 2 - FRAME

      const chassis = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.55, roughness: 0.5 })
      const body = new THREE.Mesh(chassisGeo, chassis)
      body.position.set(0, y, 0)
      group.add(body)

      // Front bezel so servers read as distinct slabs behind the posts.
      const bezel = new THREE.Mesh(
        new THREE.BoxGeometry(RACK_W - FRAME * 2.4, UNIT_H - 0.12, 0.05),
        new THREE.MeshStandardMaterial({ color: 0x1b2026, metalness: 0.3, roughness: 0.7 }),
      )
      bezel.position.set(0, y, faceZ)
      group.add(bezel)

      const statusLamp = new THREE.MeshStandardMaterial({ color: 0x0b0d10, emissive: palette.green, emissiveIntensity: 1 })
      const lamp = new THREE.Mesh(lampGeo, statusLamp)
      lamp.position.set(RACK_W / 2 - FRAME * 2.4, y, faceZ + 0.02)
      group.add(lamp)

      const activity = new THREE.MeshStandardMaterial({ color: 0x0b1a14, emissive: palette.cyan, emissiveIntensity: 0.2 })
      const bar = new THREE.Mesh(barGeo, activity)
      bar.position.set(-0.25, y - UNIT_H * 0.18, faceZ + 0.03)
      group.add(bar)

      // Invisible target spanning the slot for click-to-reboot.
      const hit = new THREE.Mesh(
        new THREE.BoxGeometry(RACK_W, UNIT_H, RACK_D),
        new THREE.MeshBasicMaterial({ visible: false }),
      )
      hit.position.set(x, y, 0)
      hit.userData.nodeId = node.id
      this.world.add(hit)
      this.hitTargets.push(hit)

      servers.push({ node, chassis, statusLamp, activity })
    }

    // Exhaust fans on the roof.
    const fans: THREE.Group[] = []
    const fanMat = new THREE.MeshStandardMaterial({ color: palette.steel, metalness: 0.5, roughness: 0.5 })
    for (let f = 0; f < 2; f++) {
      const shroud = new THREE.Mesh(
        new THREE.CylinderGeometry(0.62, 0.62, 0.16, 20, 1, true),
        new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.5, roughness: 0.5, side: THREE.DoubleSide }),
      )
      shroud.position.set((f - 0.5) * RACK_W * 0.42, height + 0.1, 0)
      group.add(shroud)
      const fan = new THREE.Group()
      fan.position.copy(shroud.position)
      fan.rotation.x = Math.PI / 2
      group.add(fan)
      const blade = new THREE.BoxGeometry(1.04, 0.03, 0.2)
      for (let b = 0; b < 4; b++) {
        const mesh = new THREE.Mesh(blade, fanMat)
        mesh.rotation.z = (b * Math.PI) / 2
        fan.add(mesh)
      }
      fans.push(fan)
    }

    const exhaustMaterial = new THREE.MeshBasicMaterial({
      color: palette.red,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
    })
    const exhaust = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), exhaustMaterial, STREAKS)
    exhaust.frustumCulled = false
    exhaust.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    group.add(exhaust)

    return { x, servers, fans, exhaust, exhaustMaterial }
  }

  /** A glowing wall monitor behind the racks, graphing rack power and load. */
  private buildDisplay(spanX: number): void {
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 144
    const context = canvas.getContext('2d')!
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    this.display = { texture, context }

    const width = Math.min(spanX + 1.5, 6)
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(width, width * 0.56),
      new THREE.MeshBasicMaterial({ map: texture }),
    )
    screen.position.set(0, this.rackHeight * 0.62, -RACK_D / 2 - 1.6)
    this.world.add(screen)
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(width + 0.2, width * 0.56 + 0.2, 0.08),
      new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.5, roughness: 0.5 }),
    )
    frame.position.copy(screen.position).setZ(screen.position.z - 0.05)
    this.world.add(frame)
    this.drawDisplay()
  }

  private drawDisplay(): void {
    if (!this.display) return
    const { context: g, texture } = this.display
    const w = 256
    const h = 144
    g.fillStyle = '#0a0d11'
    g.fillRect(0, 0, w, h)

    g.strokeStyle = 'rgba(120,140,160,0.14)'
    g.lineWidth = 1
    for (let i = 1; i < 4; i++) {
      const y = (h / 4) * i
      g.beginPath()
      g.moveTo(0, y)
      g.lineTo(w, y)
      g.stroke()
    }

    const cap = this.num('powerCap')
    // PDU cap line.
    g.strokeStyle = 'rgba(255,90,79,0.5)'
    g.setLineDash([4, 3])
    g.beginPath()
    g.moveTo(0, 8)
    g.lineTo(w, 8)
    g.stroke()
    g.setLineDash([])

    const n = this.history.length
    if (n > 1) {
      // Power trace, scaled so the cap sits near the top.
      g.strokeStyle = '#ffb020'
      g.lineWidth = 2
      g.beginPath()
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w
        const y = h - 8 - (this.history[i].power / cap) * (h - 16)
        i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)
      }
      g.stroke()

      // Utilisation trace.
      g.strokeStyle = '#4cc9f0'
      g.lineWidth = 1.5
      g.beginPath()
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w
        const y = h - 8 - this.history[i].util * (h - 16)
        i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)
      }
      g.stroke()
    }

    g.fillStyle = '#e9edf2'
    g.font = '13px monospace'
    g.fillText(`${this.logic.totalPower.toFixed(1)} kW`, 8, 24)
    g.fillStyle = '#4cc9f0'
    g.fillText(`${(this.logic.utilization() * 100).toFixed(0)}% load`, 8, 40)
    texture.needsUpdate = true
  }

  /** Seeded floor cabling and patch gear around the cabinets. */
  private buildDressing(spanX: number): void {
    const bundleMat = new THREE.MeshStandardMaterial({ color: 0x242b32, roughness: 0.8 })
    const count = this.isPreview ? 3 : 6
    for (let i = 0; i < count; i++) {
      const x = this.rng.range(-spanX / 2 - 1, spanX / 2 + 1)
      const z = RACK_D / 2 + this.rng.range(0.3, 1.2)
      const conduit = new THREE.Mesh(new THREE.TorusGeometry(this.rng.range(0.18, 0.32), 0.05, 8, 20), bundleMat)
      conduit.rotation.x = Math.PI / 2
      conduit.position.set(x, 0.05, z)
      this.world.add(conduit)
    }
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.pointerStart = { x: event.clientX, y: event.clientY }
  }

  /** A click (not a camera drag) on a crashed node reboots it. */
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
    if (hit) this.logic.reboot(hit.object.userData.nodeId as number)
  }
}
