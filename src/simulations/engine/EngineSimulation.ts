import * as THREE from 'three'
import { makeIsoCamera } from '../../three/cameras'
import { mergeStaticMeshes } from '../../three/merge'
import { palette } from '../../three/palette'
import { makePlinth } from '../../three/plinth'
import { BaseSimulation } from '../core/BaseSimulation'
import type { ParamValue, StatValue } from '../core/Simulation'
import { BORE, CRANK_RADIUS, EngineLogic, ROD_LENGTH, cylinderVolume, type EngineParams } from './EngineLogic'

/** Scene units per metre: the bore is drawn 1.6 units across. */
const SCALE = 1.6 / BORE
const THROW = CRANK_RADIUS * SCALE
const ROD = ROD_LENGTH * SCALE
const SPACING = 2
const CRANK_Y = 2.45
const CROWN = 0.52
/** Underside of the head: the piston crown at top dead centre plus the clearance height. */
const HEAD_Y = CRANK_Y + THROW + ROD + CROWN + (2 * THROW) / 9
const STEM = 1.55
const CAM_Y = HEAD_Y + STEM + 0.2
const VALVE_LIFT = 0.3
const INTAKE_CENTRE = 95
const EXHAUST_CENTRE = 625
const VALVE_DURATION = 210
const DEG = Math.PI / 180

/** How far a valve is open at a point in the cycle. */
function valveLift(phase: number, centre: number): number {
  let away = Math.abs(phase - centre) % 720
  if (away > 360) away = 720 - away
  if (away > VALVE_DURATION / 2) return 0
  const c = Math.cos((Math.PI * away) / VALVE_DURATION)
  return VALVE_LIFT * c * c
}

interface CylinderParts {
  x: number
  piston: THREE.Group
  rod: THREE.Group
  gas: THREE.Mesh
  gasMaterial: THREE.MeshBasicMaterial
  intake: THREE.Group
  exhaust: THREE.Group
  spark: THREE.Mesh
  flash: number
  lastPhase: number
}

export default class EngineSimulation extends BaseSimulation {
  private logic!: EngineLogic
  private count = 4
  private parts: CylinderParts[] = []
  private crank!: THREE.Group
  private cam!: THREE.Group
  private butterfly!: THREE.Mesh
  private exhaustGlow!: THREE.MeshStandardMaterial
  /** Crank angle being shown. It turns at a fraction of the true speed so the strokes can be followed. */
  private shown = 0
  private stalledFor = 0
  private scopeContext!: CanvasRenderingContext2D
  private scopeTexture!: THREE.CanvasTexture
  private frame = 0
  private cold = new THREE.Color(0x4cc9f0)
  private warm = new THREE.Color(0xff7a1a)
  private hot = new THREE.Color(0xfff2c0)
  private spent = new THREE.Color(0x8a8f96)

  constructor() {
    super(makeIsoCamera(new THREE.Vector3(0.82, 0.5, 1)))
    this.params = { throttle: 12, load: 40, cylinders: '4', advance: 22, playback: 6, ignition: true }
  }

  protected build(): void {
    this.parts = []
    this.shown = 0
    this.stalledFor = 0
    this.frame = 0
    this.count = Number(this.params.cylinders) || 4
    this.logic = new EngineLogic(this.count, this.readParams())
    this.logic.start()

    const length = this.count * SPACING
    this.world.add(makePlinth(Math.max(length + 7.5, 11), 8.4))
    this.buildBlock(length)
    this.buildCrank(length)
    this.buildHead(length)
    this.buildCylinders()
    this.buildScope(length)

    this.enableShadows(this.world)
    for (const part of this.parts) {
      part.gas.castShadow = false
      part.gas.receiveShadow = false
      part.spark.castShadow = false
    }
    this.lighting.setShadowExtent(Math.max(10, length))
    this.world.position.y = -4.3
    const half = length / 2 + 5
    this.setView(this.isPreview ? half * 0.92 : half, this.isPreview ? 6 : 6.7)
  }

  protected update(dt: number): void {
    const { logic } = this
    logic.step(dt)
    this.shown = (this.shown + ((logic.speed * dt) / DEG) * (this.num('playback') / 100)) % 720

    if (logic.status === 'stalled') {
      if (this.stalledFor === 0) {
        this.events.emit({
          type: 'engine_stalled',
          level: 'warn',
          title: 'ENGINE STALLED',
          message: 'The brake asked for more torque than the engine could make. Ease the load or open the throttle.',
        })
      }
      this.stalledFor += dt
      // Try the starter again after a pause.
      if (this.stalledFor > 3) {
        this.stalledFor = 0
        logic.start()
      }
    } else {
      this.stalledFor = 0
    }

    const shownRate = (logic.speed / DEG) * (this.num('playback') / 100)
    for (const part of this.parts) part.flash = Math.max(0, part.flash - dt * Math.max(4, shownRate / 40))
  }

  render(_alpha: number): void {
    const { logic } = this
    this.crank.rotation.x = this.shown * DEG
    this.cam.rotation.x = (this.shown / 2) * DEG
    this.butterfly.rotation.z = Math.PI / 2 - (0.08 + 0.92 * (this.num('throttle') / 100)) * (Math.PI / 2)
    this.exhaustGlow.emissiveIntensity = Math.min(1.6, Math.max(0, logic.power / 45000))

    this.parts.forEach((part, index) => {
      const phase = logic.phase(index, this.shown)
      const a = phase * DEG
      const side = THROW * Math.sin(a)
      const pinY = CRANK_Y + THROW * Math.cos(a)
      const pistonY = pinY + Math.sqrt(ROD * ROD - side * side)
      part.piston.position.y = pistonY
      part.rod.position.set(part.x, pinY, side)
      part.rod.rotation.x = -Math.asin(side / ROD)
      part.intake.position.y = HEAD_Y - valveLift(phase, INTAKE_CENTRE)
      part.exhaust.position.y = HEAD_Y - valveLift(phase, EXHAUST_CENTRE)

      // The gas above the piston, coloured by what is happening to it. Every cylinder
      // replays cylinder 1's latest measured cycle at its own point in the firing order.
      const degree = Math.floor(phase) % 720
      const pressure = logic.tracePressure[degree]
      const temperature = logic.traceTemperature[degree]
      const top = pistonY + CROWN
      part.gas.position.y = top
      part.gas.scale.y = Math.max(0.02, HEAD_Y - top)
      const material = part.gasMaterial
      if (phase < 180) {
        material.color.copy(this.cold)
        material.opacity = 0.16 + 0.1 * Math.min(1, pressure / 101325)
      } else if (phase >= 500) {
        material.color.copy(this.spent)
        material.opacity = 0.3
      } else {
        const heat = Math.min(1, Math.max(0, (temperature - 500) / 1900))
        material.color.copy(this.cold).lerp(this.warm, Math.min(1, heat * 2.2)).lerp(this.hot, Math.max(0, heat * 1.6 - 0.6))
        material.opacity = 0.22 + 0.6 * Math.min(1, pressure / 3.5e6)
      }

      // Spark: flashes as the shown crank passes the firing point.
      const spark = 360 - Math.min(this.num('advance'), 4 + logic.rpm / 40)
      if (logic.firing && part.lastPhase < spark && phase >= spark && phase - part.lastPhase < 90) part.flash = 1
      part.lastPhase = phase
      part.spark.scale.setScalar(0.001 + part.flash * 1.3)
    })

    if (this.frame++ % (this.isPreview ? 6 : 3) === 0) this.drawScope()
  }

  protected onParam(key: string, _value: ParamValue): void {
    if (key === 'cylinders') {
      this.rebuild()
      return
    }
    Object.assign(this.logic.params, this.readParams())
    if (key === 'ignition' && this.bool('ignition')) this.logic.start()
  }

  action(key: string): void {
    if (key === 'start') this.logic.start()
  }

  getStats(): Record<string, StatValue> {
    const { logic } = this
    let peak = 0
    for (const pressure of logic.tracePressure) peak = Math.max(peak, pressure)
    const state = { off: 'OFF', cranking: 'CRANKING', running: logic.firing ? 'RUNNING' : this.bool('ignition') ? 'REV LIMIT' : 'COASTING', stalled: 'STALLED' }[logic.status]
    return {
      state,
      rpm: logic.rpm.toFixed(0),
      torque: logic.torque.toFixed(0),
      power: (logic.power / 1000).toFixed(1),
      map: (logic.manifold / 1000).toFixed(0),
      peak: (peak / 1e5).toFixed(0),
      efficiency: (logic.efficiency * 100).toFixed(0),
      ripple: (logic.ripple * 100).toFixed(1),
      fuel: (logic.fuelRate * 1000).toFixed(2),
      layout: `${logic.displacement.toFixed(1)} L inline-${this.count}`,
      firing: ((logic.rpm / 120) * this.count).toFixed(1),
      throttle: this.num('throttle'),
    }
  }

  entityCount(): number {
    return this.count * 6
  }

  private readParams(): EngineParams {
    return {
      throttle: this.num('throttle') / 100,
      load: this.num('load'),
      advance: this.num('advance'),
      ignition: this.bool('ignition'),
    }
  }

  private xOf(index: number): number {
    return (index - (this.count - 1) / 2) * SPACING
  }

  private add(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(x, y, z)
    parent.add(mesh)
    return mesh
  }

  /** A cylinder lying along the crank axis. */
  private across(radius: number, length: number, segments = 20): THREE.BufferGeometry {
    return new THREE.CylinderGeometry(radius, radius, length, segments).rotateZ(Math.PI / 2)
  }

  /** The back half of the block and sump: everything in front of the cylinder axes is cut away. */
  private buildBlock(length: number): void {
    const iron = new THREE.MeshStandardMaterial({ color: 0x4a525c, metalness: 0.55, roughness: 0.55 })
    const cut = new THREE.MeshStandardMaterial({ color: 0xb5483f, roughness: 0.7 })
    const liner = new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.75, roughness: 0.3, side: THREE.DoubleSide })
    const dark = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.5, roughness: 0.5 })
    const oil = new THREE.MeshStandardMaterial({ color: 0x9a6a12, roughness: 0.25, transparent: true, opacity: 0.7 })
    const fixed = new THREE.Group()
    this.world.add(fixed)
    const width = length + 0.5
    const deckBottom = CRANK_Y + 1.5
    const linerHeight = HEAD_Y - deckBottom

    // Cylinder bank: back wall, the liners, and the webs between them with their cut faces painted.
    this.add(fixed, new THREE.BoxGeometry(width, linerHeight, 0.35), iron, 0, deckBottom + linerHeight / 2, -1.02)
    for (let i = 0; i < this.count; i++) {
      this.add(fixed, new THREE.CylinderGeometry(0.82, 0.82, linerHeight, 28, 1, true, Math.PI / 2, Math.PI), liner, this.xOf(i), deckBottom + linerHeight / 2, 0)
    }
    for (let i = 0; i <= this.count; i++) {
      const x = this.xOf(i) - SPACING / 2
      const wide = i === 0 || i === this.count ? 0.25 : 0.34
      this.add(fixed, new THREE.BoxGeometry(wide, linerHeight, 0.86), iron, x + (i === 0 ? 0.045 : i === this.count ? -0.045 : 0), deckBottom + linerHeight / 2, -0.43)
      this.add(fixed, new THREE.BoxGeometry(wide, linerHeight, 0.02), cut, x + (i === 0 ? 0.045 : i === this.count ? -0.045 : 0), deckBottom + linerHeight / 2, 0.005)
    }

    // Crankcase: back wall, main bearing webs, and a sump with oil in it.
    this.add(fixed, new THREE.BoxGeometry(width, 3.4, 0.3), iron, 0, CRANK_Y - 0.2, -1.4)
    for (let i = 0; i <= this.count; i++) {
      const x = this.xOf(i) - SPACING / 2
      this.add(fixed, new THREE.BoxGeometry(0.3, 2.2, 1.7), iron, x, CRANK_Y + 0.42, -0.42)
      this.add(fixed, new THREE.BoxGeometry(0.3, 2.2, 0.02), cut, x, CRANK_Y + 0.42, 0.435)
    }
    this.add(fixed, new THREE.BoxGeometry(width, 0.16, 2.9), dark, 0, CRANK_Y - 1.86, 0)
    this.add(fixed, new THREE.BoxGeometry(0.16, 1.2, 2.9), dark, -width / 2 + 0.08, CRANK_Y - 1.3, 0)
    this.add(fixed, new THREE.BoxGeometry(0.16, 1.2, 2.9), dark, width / 2 - 0.08, CRANK_Y - 1.3, 0)
    const pool = this.add(this.world, new THREE.BoxGeometry(width - 0.34, 0.36, 2.7), oil, 0, CRANK_Y - 1.6, 0)
    pool.castShadow = false

    // Stand.
    for (const x of [-width / 2 + 0.6, width / 2 - 0.6]) {
      this.add(fixed, new THREE.BoxGeometry(0.5, CRANK_Y - 1.94, 2.2), dark, x, (CRANK_Y - 1.94) / 2, 0)
      this.add(fixed, new THREE.BoxGeometry(1.1, 0.14, 3), dark, x, 0.07, 0)
    }
    mergeStaticMeshes(fixed)
  }

  /** Crankshaft with a throw and counterweights per cylinder, flywheel, and the pulley that drives the cam. */
  private buildCrank(length: number): void {
    const steel = new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.85, roughness: 0.28 })
    const forged = new THREE.MeshStandardMaterial({ color: palette.steel, metalness: 0.7, roughness: 0.4 })
    const dark = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.5, roughness: 0.5 })
    const mark = new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.5 })
    this.crank = new THREE.Group()
    this.crank.position.y = CRANK_Y
    this.world.add(this.crank)

    this.add(this.crank, this.across(0.3, length + 3.6), steel, 0.25, 0, 0)
    for (let i = 0; i < this.count; i++) {
      const throwGroup = new THREE.Group()
      throwGroup.position.x = this.xOf(i)
      // Built at the angle that puts this cylinder at top dead centre when its turn comes.
      throwGroup.rotation.x = -this.logic.cylinders[i].offset * DEG
      this.crank.add(throwGroup)
      this.add(throwGroup, this.across(0.28, 0.66), steel, 0, THROW, 0)
      for (const side of [-1, 1]) {
        this.add(throwGroup, new THREE.BoxGeometry(0.2, THROW + 0.7, 0.62), forged, side * 0.43, THROW / 2, 0)
        // Counterweight: a half disc opposite the pin.
        const weight = new THREE.CylinderGeometry(1.08, 1.08, 0.2, 24, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateX(Math.PI)
        this.add(throwGroup, weight, forged, side * 0.43, 0, 0)
      }
    }

    // Flywheel with a ring gear and marks so its turning can be seen.
    const flywheelX = length / 2 + 1.25
    this.add(this.crank, this.across(1.5, 0.3, 40), forged, flywheelX, 0, 0)
    this.add(this.crank, this.across(1.58, 0.16, 40), dark, flywheelX, 0, 0)
    for (let i = 0; i < 6; i++) {
      const angle = (i * Math.PI) / 3
      this.add(this.crank, this.across(0.17, 0.34, 12), i === 0 ? mark : dark, flywheelX, Math.cos(angle) * 0.95, Math.sin(angle) * 0.95)
    }

    // Timing drive at the other end: the cam pulley is twice the size, so the cam turns at half speed.
    const beltX = -length / 2 - 1.05
    this.add(this.crank, this.across(0.42, 0.34, 24), dark, beltX, 0, 0)
    this.add(this.crank, new THREE.BoxGeometry(0.36, 0.1, 0.1), mark, beltX, 0.3, 0)
    this.cam = new THREE.Group()
    this.cam.position.y = CAM_Y
    this.world.add(this.cam)
    this.add(this.cam, this.across(0.12, length + 2.4), steel, -0.45, 0, 0)
    this.add(this.cam, this.across(0.84, 0.34, 32), dark, beltX, 0, 0)
    for (let i = 0; i < 5; i++) {
      const angle = (i * Math.PI * 2) / 5
      this.add(this.cam, this.across(0.16, 0.36, 10), i === 0 ? mark : steel, beltX, Math.cos(angle) * 0.5, Math.sin(angle) * 0.5)
    }
    const rubber = new THREE.MeshStandardMaterial({ color: palette.rubber, roughness: 0.9 })
    const rise = CAM_Y - CRANK_Y
    const run = Math.hypot(rise, 0.42)
    for (const side of [-1, 1]) {
      const strand = this.add(this.world, new THREE.BoxGeometry(0.3, run, 0.05), rubber, beltX, (CAM_Y + CRANK_Y) / 2, side * 0.65)
      strand.rotation.x = side * Math.atan2(0.42, rise)
    }
  }

  /** Cylinder head: chamber roof, camshaft lobes, manifolds and the throttle. */
  private buildHead(length: number): void {
    const alloy = new THREE.MeshStandardMaterial({ color: 0x8b95a1, metalness: 0.6, roughness: 0.45 })
    const cut = new THREE.MeshStandardMaterial({ color: 0xb5483f, roughness: 0.7 })
    const steel = new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.85, roughness: 0.28 })
    const intake = new THREE.MeshStandardMaterial({ color: 0x3f7f9a, metalness: 0.5, roughness: 0.45 })
    this.exhaustGlow = new THREE.MeshStandardMaterial({ color: 0x6b4a3a, metalness: 0.6, roughness: 0.5, emissive: 0xff4a12, emissiveIntensity: 0 })
    const fixed = new THREE.Group()
    this.world.add(fixed)
    const width = length + 0.5

    this.add(fixed, new THREE.BoxGeometry(width, 0.16, 1.02), alloy, 0, HEAD_Y + 0.08, -0.69)
    this.add(fixed, new THREE.BoxGeometry(width, STEM + 0.7, 0.4), alloy, 0, HEAD_Y + (STEM + 0.7) / 2, -1)
    this.add(fixed, new THREE.BoxGeometry(width, 0.16, 0.02), cut, 0, HEAD_Y + 0.08, -0.175)
    // Cam bearing caps.
    for (let i = 0; i <= this.count; i++) this.add(fixed, new THREE.BoxGeometry(0.26, 0.6, 0.9), alloy, this.xOf(i) - SPACING / 2, CAM_Y - 0.05, -0.4)

    // Lobes: each points down when its valve should be fully open.
    for (let i = 0; i < this.count; i++) {
      const offset = this.logic.cylinders[i].offset
      for (const [dx, centre] of [[-0.38, INTAKE_CENTRE], [0.38, EXHAUST_CENTRE]]) {
        const lobe = new THREE.Group()
        lobe.position.x = this.xOf(i) + dx
        lobe.rotation.x = Math.PI - ((offset + centre) / 2) * DEG
        this.cam.add(lobe)
        this.add(lobe, this.across(0.2, 0.3, 20), steel, 0, 0, 0)
        this.add(lobe, this.across(0.13, 0.3, 16), steel, 0, 0.36, 0)
        this.add(lobe, new THREE.BoxGeometry(0.3, 0.36, 0.3), steel, 0, 0.18, 0)
      }
    }

    // Intake: a plenum behind the head, a runner to each cylinder, and the throttle at one end.
    const plenumY = HEAD_Y + 1.25
    this.add(fixed, this.across(0.42, width - 0.2, 24), intake, 0, plenumY, -2.25)
    for (let i = 0; i < this.count; i++) {
      this.add(fixed, new THREE.BoxGeometry(0.34, 0.34, 1.2), intake, this.xOf(i) - 0.38, plenumY - 0.35, -1.7)
      const pipe = this.add(fixed, new THREE.BoxGeometry(0.3, 0.3, 1.25), this.exhaustGlow, this.xOf(i) + 0.38, HEAD_Y + 0.05, -1.65)
      pipe.rotation.x = 0.55
    }
    this.add(fixed, this.across(0.34, width - 0.4, 20), this.exhaustGlow, 0.5, HEAD_Y - 0.42, -2.2)
    const throttleX = -width / 2 - 0.45
    this.add(fixed, this.across(0.46, 0.7, 24), intake, throttleX, plenumY, -2.25)
    this.butterfly = this.add(this.world, new THREE.CylinderGeometry(0.36, 0.36, 0.04, 24), new THREE.MeshStandardMaterial({ color: palette.amber, metalness: 0.4, roughness: 0.4 }), throttleX - 0.37, plenumY, -2.25)
    mergeStaticMeshes(fixed)
  }

  /** The moving parts of each cylinder: piston, rod, valves, plug and the gas itself. */
  private buildCylinders(): void {
    const alloy = new THREE.MeshStandardMaterial({ color: 0xc3ccd6, metalness: 0.75, roughness: 0.3 })
    const forged = new THREE.MeshStandardMaterial({ color: palette.steel, metalness: 0.7, roughness: 0.4 })
    const ring = new THREE.MeshStandardMaterial({ color: 0x23282e, metalness: 0.6, roughness: 0.4 })
    const cool = new THREE.MeshStandardMaterial({ color: 0x6fb7d6, metalness: 0.7, roughness: 0.3 })
    const scorched = new THREE.MeshStandardMaterial({ color: 0xc98a4a, metalness: 0.7, roughness: 0.35 })
    const ceramic = new THREE.MeshStandardMaterial({ color: palette.white, roughness: 0.5 })
    const glow = new THREE.MeshBasicMaterial({ color: 0xbfe6ff, toneMapped: false })

    for (let i = 0; i < this.count; i++) {
      const x = this.xOf(i)
      const piston = new THREE.Group()
      piston.position.x = x
      this.world.add(piston)
      this.add(piston, new THREE.CylinderGeometry(0.77, 0.77, 0.95, 28), alloy, 0, CROWN - 0.475, 0)
      for (let k = 0; k < 3; k++) this.add(piston, new THREE.CylinderGeometry(0.785, 0.785, 0.045, 28), ring, 0, CROWN - 0.12 - k * 0.13, 0)
      this.add(piston, this.across(0.15, 1.2, 14), forged, 0, 0, 0)

      // Connecting rod, built hanging from its big end so it can be aimed at the piston pin.
      const rod = new THREE.Group()
      this.world.add(rod)
      this.add(rod, new THREE.BoxGeometry(0.2, ROD, 0.3), forged, 0, ROD / 2, 0)
      this.add(rod, this.across(0.4, 0.24, 20), forged, 0, 0, 0)
      this.add(rod, this.across(0.25, 0.24, 16), forged, 0, ROD, 0)

      const gasMaterial = new THREE.MeshBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.2, depthWrite: false, toneMapped: false })
      const gas = this.add(this.world, new THREE.CylinderGeometry(0.75, 0.75, 1, 24).translate(0, 0.5, 0), gasMaterial, x, HEAD_Y - 0.2, 0)

      const valve = (dx: number, material: THREE.Material) => {
        const group = new THREE.Group()
        group.position.set(x + dx, HEAD_Y, 0.02)
        this.world.add(group)
        this.add(group, new THREE.CylinderGeometry(0.3, 0.2, 0.09, 20), material, 0, 0.045, 0)
        this.add(group, new THREE.CylinderGeometry(0.055, 0.055, STEM, 10), material, 0, STEM / 2, 0)
        this.add(group, new THREE.CylinderGeometry(0.17, 0.17, 0.14, 14), alloy, 0, STEM - 0.07, 0)
        return group
      }
      const intake = valve(-0.38, cool)
      const exhaust = valve(0.38, scorched)

      this.add(this.world, new THREE.CylinderGeometry(0.1, 0.1, 0.9, 12), ceramic, x, HEAD_Y + 0.55, -0.3)
      this.add(this.world, new THREE.CylinderGeometry(0.04, 0.04, 0.2, 8), forged, x, HEAD_Y + 0.02, -0.3)
      const spark = this.add(this.world, new THREE.SphereGeometry(0.2, 12, 8), glow, x, HEAD_Y - 0.1, -0.2)
      spark.scale.setScalar(0.001)

      this.parts.push({ x, piston, rod, gas, gasMaterial, intake, exhaust, spark, flash: 0, lastPhase: 0 })
    }
  }

  /** An indicator diagram: cylinder pressure against volume, as an engineer's test cell would show it. */
  private buildScope(length: number): void {
    const canvas = document.createElement('canvas')
    canvas.width = this.isPreview ? 320 : 640
    canvas.height = this.isPreview ? 200 : 400
    this.scopeContext = canvas.getContext('2d')!
    this.scopeTexture = new THREE.CanvasTexture(canvas)
    this.scopeTexture.colorSpace = THREE.SRGBColorSpace
    const shell = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.7, roughness: 0.4 })
    const group = new THREE.Group()
    group.position.set(length / 2 + 2.2, 0, -2.6)
    group.rotation.y = 0.5
    this.world.add(group)
    this.add(group, new THREE.BoxGeometry(3.5, 2.4, 0.4), shell, 0, 3.4, 0)
    this.add(group, new THREE.BoxGeometry(0.3, 2.3, 0.3), shell, 0, 1.15, 0)
    this.add(group, new THREE.BoxGeometry(1.8, 0.14, 1.2), shell, 0, 0.07, 0)
    const screen = this.add(group, new THREE.PlaneGeometry(3.2, 2), new THREE.MeshBasicMaterial({ map: this.scopeTexture, toneMapped: false }), 0, 3.4, 0.21)
    screen.castShadow = false
  }

  private drawScope(): void {
    const context = this.scopeContext
    const { logic } = this
    const width = context.canvas.width
    const height = context.canvas.height
    const unit = width / 640
    context.fillStyle = '#080b0e'
    context.fillRect(0, 0, width, height)

    const left = 54 * unit
    const right = width - 18 * unit
    const top = 40 * unit
    const bottom = height - 34 * unit
    const low = cylinderVolume(0)
    const high = cylinderVolume(180)
    // Pressure on a log scale from 0.1 to 100 bar, so the faint pumping loop shows beside the power loop.
    const px = (volume: number) => left + ((volume - low) / (high - low)) * (right - left)
    const py = (pressure: number) => bottom - ((Math.log10(Math.max(pressure, 1e4)) - 4) / 3) * (bottom - top)

    context.strokeStyle = '#1c2630'
    context.lineWidth = unit
    context.font = `${12 * unit}px ui-monospace, monospace`
    context.fillStyle = '#6f7c88'
    for (const [bar, label] of [[0.1, '0.1'], [1, '1'], [10, '10'], [100, '100']] as const) {
      const y = py(bar * 1e5)
      context.beginPath()
      context.moveTo(left, y)
      context.lineTo(right, y)
      context.stroke()
      context.fillText(label, 14 * unit, y + 4 * unit)
    }
    context.fillText('bar', 14 * unit, top - 14 * unit)
    context.fillText('TDC', left - 6 * unit, height - 12 * unit)
    context.fillText('BDC', right - 26 * unit, height - 12 * unit)

    context.strokeStyle = '#ffb020'
    context.lineWidth = 2 * unit
    context.beginPath()
    for (let degree = 0; degree <= 720; degree++) {
      const x = px(cylinderVolume(degree))
      const y = py(logic.tracePressure[degree % 720])
      if (degree === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    }
    context.stroke()

    const now = Math.floor(logic.phase(0, this.shown)) % 720
    context.fillStyle = '#4cc9f0'
    context.beginPath()
    context.arc(px(cylinderVolume(now)), py(logic.tracePressure[now]), 5 * unit, 0, Math.PI * 2)
    context.fill()

    context.fillStyle = '#e9edf2'
    context.font = `${15 * unit}px ui-monospace, monospace`
    context.fillText('CYLINDER 1  PRESSURE / VOLUME', left, 22 * unit)
    context.fillStyle = '#ffb020'
    const stroke = ['INTAKE', 'COMPRESSION', 'POWER', 'EXHAUST'][Math.floor(now / 180)]
    context.fillText(`${logic.rpm.toFixed(0)} rpm   ${stroke}`, left + 250 * unit, 60 * unit)
    this.scopeTexture.needsUpdate = true
  }
}
