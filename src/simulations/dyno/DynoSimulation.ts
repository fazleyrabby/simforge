import * as THREE from 'three'
import { makeIsoCamera } from '../../three/cameras'
import { carColors, palette } from '../../three/palette'
import { makePlinth } from '../../three/plinth'
import { BaseSimulation } from '../core/BaseSimulation'
import { Rng } from '../core/random'
import type { ParamValue, StatValue } from '../core/Simulation'
import { DynoLogic, generateCycle, generateVehicle, type BodyStyle, type DynoParams } from './DynoLogic'

const DECK = 0.4
const AXLE = 1.3
const TRACK = 0.8
const ROLLER_RADIUS = 0.24
const GRAPH_SECONDS = 24
const GRAPH_RATE = 10

const BODY_WIDTH = 1.76
const CABIN_WIDTH = 1.46

/**
 * Per-style cabin outline in side view as [x, y] points, front of the car at
 * +X: windshield base, windshield top, rear-window top, rear-window base.
 * `tail` is where the rear deck ends before curving down to the bumper.
 */
const cabins: Record<BodyStyle, { glass: [number, number][]; tail: [number, number]; doors: number }> = {
  sedan: { glass: [[0.95, 0.9], [0.3, 1.36], [-0.75, 1.36], [-1.5, 0.92]], tail: [-2.0, 0.88], doors: 2 },
  hatch: { glass: [[0.95, 0.9], [0.35, 1.4], [-1.45, 1.37], [-1.98, 0.92]], tail: [-2.02, 0.88], doors: 2 },
  coupe: { glass: [[0.85, 0.9], [0.15, 1.27], [-0.5, 1.27], [-1.72, 0.9]], tail: [-2.02, 0.86], doors: 1 },
}

interface Wheel {
  group: THREE.Group
  driven: boolean
}

export default class DynoSimulation extends BaseSimulation {
  private logic!: DynoLogic
  /** Randomness for visual effects only; never feeds the simulation. */
  private fx = new Rng(1)
  private body!: THREE.Group
  private wheels: Wheel[] = []
  private rollers: THREE.Group[] = []
  private fan!: THREE.Group
  private brakeLights!: THREE.MeshStandardMaterial
  private streaks!: THREE.InstancedMesh
  private streakState: { x: number; y: number; z: number }[] = []
  private smoke!: THREE.InstancedMesh
  private smokeState: { x: number; y: number; z: number; age: number; life: number }[] = []
  private smokeDebt = 0
  private roof: [number, number][] = []

  private wheelAngle = 0
  private rollerAngle = 0
  private fanAngle = 0
  private pitch = 0
  private slipAlertAt = -Infinity

  private graphContext!: CanvasRenderingContext2D
  private graphTexture!: THREE.CanvasTexture
  private history: { speed: number; target: number }[] = []
  private graphTimer = 0

  private matrix = new THREE.Matrix4()
  private position = new THREE.Vector3()
  private scale = new THREE.Vector3()
  private rotation = new THREE.Quaternion()

  constructor() {
    super(makeIsoCamera(new THREE.Vector3(0.95, 0.68, 1.2)))
    this.params = { mode: 'cycle', throttle: 40, grade: 0, grip: 1, wind: 0 }
  }

  protected build(): void {
    this.wheels = []
    this.rollers = []
    this.history = []
    this.wheelAngle = 0
    this.rollerAngle = 0
    this.pitch = 0
    this.smokeDebt = 0
    this.slipAlertAt = -Infinity
    this.fx = new Rng(this.seed + 1)
    this.world.position.y = -1

    const vehicle = generateVehicle(this.rng, carColors)
    this.logic = new DynoLogic(vehicle, generateCycle(this.rng), this.readParams())
    this.logic.onPowerRunEnd = (result) => {
      this.events.emit({
        type: 'power_run_complete',
        level: 'info',
        title: 'POWER RUN COMPLETE',
        message: `${vehicle.name}: peak ${(result.peakPower / 1000).toFixed(0)} kW at ${Math.round(result.peakRpm / 10) * 10} rpm.`,
      })
    }

    this.world.add(makePlinth(13, 9))
    this.buildRig()
    this.buildCar()
    this.buildFan()
    this.buildReadout()
    this.buildDressing()
    this.buildEffects()

    this.enableShadows(this.world)
    this.streaks.castShadow = false
    this.smoke.castShadow = false
    this.lighting.setShadowExtent(10)
    this.setView(this.isPreview ? 6.4 : 9, this.isPreview ? 4.2 : 6)
  }

  protected update(dt: number): void {
    const { logic } = this
    logic.step(dt)

    this.wheelAngle += (logic.wheelSpeed / logic.vehicle.wheelRadius) * dt
    this.rollerAngle += (logic.rollerSpeed / ROLLER_RADIUS) * dt
    const airspeed = logic.rollerSpeed + logic.params.wind
    this.fanAngle += (1.5 + airspeed * 1.4) * dt
    // The body squats under acceleration and dives under braking.
    this.pitch += (THREE.MathUtils.clamp(logic.acceleration * 0.007, -0.03, 0.03) - this.pitch) * Math.min(1, dt * 6)

    this.updateStreaks(dt, airspeed)
    this.updateSmoke(dt)

    this.graphTimer += dt
    if (this.graphTimer >= 1 / GRAPH_RATE) {
      this.graphTimer = 0
      this.history.push({ speed: logic.rollerSpeed, target: logic.targetSpeed() })
      if (this.history.length > GRAPH_SECONDS * GRAPH_RATE) this.history.shift()
      this.drawGraph()
    }

    if (logic.slip > 0.3 && this.time - this.slipAlertAt > 8) {
      this.slipAlertAt = this.time
      this.events.emit({
        type: 'wheel_slip',
        level: 'warn',
        title: 'WHEEL SLIP',
        message: 'Tyres are spinning on the rollers. Ease the throttle or raise roller grip.',
      })
    }
  }

  render(): void {
    const { logic } = this
    for (const wheel of this.wheels) if (wheel.driven) wheel.group.rotation.z = -this.wheelAngle
    for (const roller of this.rollers) roller.rotation.z = this.rollerAngle
    this.fan.rotation.x = this.fanAngle

    const shake = this.ctx.reducedMotion ? 0 : Math.sin(this.time * 70) * 0.0035 * (0.25 + logic.throttle)
    this.body.position.y = DECK + shake
    this.body.rotation.z = logic.vehicle.drivenAxle === 'rear' ? this.pitch : -this.pitch * 0.6
    this.brakeLights.emissiveIntensity = 0.4 + logic.brake * 3
  }

  action(key: string): void {
    if (key === 'powerRun') this.logic.startPowerRun()
  }

  protected onParam(_key: string, _value: ParamValue): void {
    this.logic.params = this.readParams()
  }

  getStats(): Record<string, StatValue> {
    const { logic } = this
    return {
      vehicle: logic.vehicle.name,
      speed: (logic.rollerSpeed * 3.6).toFixed(0),
      rpm: (Math.round(logic.rpm / 10) * 10).toString(),
      gear: `${logic.gear + 1} / ${logic.vehicle.gears.length}`,
      power: (logic.wheelPower / 1000).toFixed(0),
      slip: (Math.max(0, logic.slip) * 100).toFixed(0),
      peak: logic.peakPower > 0 ? (logic.peakPower / 1000).toFixed(0) : '—',
      distance: (logic.distance / 1000).toFixed(2),
    }
  }

  entityCount(): number {
    return 1 + this.streakState.length + this.smokeState.filter((puff) => puff.age < puff.life).length
  }

  private readParams(): DynoParams {
    return {
      mode: this.params.mode === 'manual' ? 'manual' : 'cycle',
      throttle: this.num('throttle') / 100,
      grade: this.num('grade'),
      grip: this.num('grip'),
      wind: this.num('wind') / 3.6,
    }
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

  /** The dynamometer bed: a raised deck with twin rollers under the driven axle. */
  private buildRig(): void {
    const { vehicle } = this.logic
    const steel = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.5, roughness: 0.55 })
    const drivenX = vehicle.drivenAxle === 'front' ? AXLE : -AXLE

    this.add(this.world, new THREE.BoxGeometry(6.6, DECK, 3.2), steel, 0, DECK / 2, 0)
    // Dark pit plate the rollers sit in.
    this.add(
      this.world,
      new THREE.BoxGeometry(1.5, 0.02, 2.5),
      new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.9 }),
      drivenX,
      DECK + 0.005,
      0,
    )
    for (const side of [-1, 1]) {
      this.add(
        this.world,
        new THREE.BoxGeometry(6.6, 0.02, 0.12),
        new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.8 }),
        0,
        DECK + 0.011,
        side * 1.5,
      )
    }

    const rollerGeometry = new THREE.CylinderGeometry(ROLLER_RADIUS, ROLLER_RADIUS, 2.3, 24)
    rollerGeometry.rotateX(Math.PI / 2)
    const rollerMaterial = new THREE.MeshStandardMaterial({ color: palette.steel, metalness: 0.75, roughness: 0.3 })
    const markMaterial = new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.4, roughness: 0.5 })
    const markGeometry = new THREE.BoxGeometry(0.03, 0.012, 2.3)
    for (const offset of [-0.29, 0.29]) {
      const roller = new THREE.Group()
      roller.position.set(drivenX + offset, DECK - ROLLER_RADIUS + 0.09, 0)
      this.add(roller, rollerGeometry, rollerMaterial, 0, 0, 0)
      // Raised strips make the roller's rotation readable.
      for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2
        const mark = this.add(roller, markGeometry, markMaterial, Math.cos(angle) * ROLLER_RADIUS, Math.sin(angle) * ROLLER_RADIUS, 0)
        mark.rotation.z = angle + Math.PI / 2
      }
      this.world.add(roller)
      this.rollers.push(roller)
    }

    // Chocks hold the undriven wheels.
    const chock = new THREE.BoxGeometry(0.16, 0.14, 0.3)
    const chockMaterial = new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.7 })
    for (const side of [-1, 1]) {
      for (const along of [-1, 1]) {
        this.add(this.world, chock, chockMaterial, -drivenX + along * 0.4, DECK + 0.07, side * TRACK).rotation.z = along * 0.5
      }
    }
  }

  private buildCar(): void {
    const { vehicle } = this.logic
    const cabin = cabins[vehicle.body]
    const [cowl, roofFront, roofRear, deck] = cabin.glass
    const tail = cabin.tail
    const rear = -2.14
    // Upper surface of the car from tail to nose, used to route airflow over it.
    this.roof = [[rear, 0.5], tail, deck, roofRear, roofFront, cowl, [2.1, 0.66], [2.16, 0.5]]

    this.body = new THREE.Group()
    this.body.position.y = DECK
    this.world.add(this.body)
    const body = this.body

    const paint = new THREE.MeshPhysicalMaterial({
      color: vehicle.color,
      metalness: 0.55,
      roughness: 0.32,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
    })
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0x1b2a33,
      metalness: 0.3,
      roughness: 0.05,
      transparent: true,
      opacity: 0.62,
    })
    const trim = new THREE.MeshStandardMaterial({ color: 0x12161a, roughness: 0.6, metalness: 0.2 })
    const chrome = new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.9, roughness: 0.2 })
    const interior = new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.85 })

    /** Extrudes a side-view outline across the car, centered on its length axis. */
    const extrude = (shape: THREE.Shape, width: number, bevel: number) => {
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: width - bevel * 2,
        bevelEnabled: bevel > 0,
        bevelSize: bevel,
        bevelOffset: -bevel,
        bevelThickness: bevel,
        bevelSegments: 3,
        curveSegments: 14,
      })
      geometry.translate(0, 0, -(width - bevel * 2) / 2)
      return geometry
    }
    const polygon = (points: [number, number][]) => new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)))

    // Lower body: sills, wheel arches, bumpers, hood and rear deck in one outline.
    const arch = 0.41
    const shell = new THREE.Shape()
    shell.moveTo(-2.02, 0.2)
    shell.lineTo(-AXLE - arch, 0.2)
    shell.absarc(-AXLE, 0.22, arch, Math.PI, 0, true)
    shell.lineTo(AXLE - arch, 0.2)
    shell.absarc(AXLE, 0.22, arch, Math.PI, 0, true)
    shell.lineTo(2.02, 0.2)
    shell.quadraticCurveTo(2.2, 0.22, 2.16, 0.5)
    shell.lineTo(2.1, 0.66)
    shell.quadraticCurveTo(1.6, 0.86, cowl[0], cowl[1])
    shell.lineTo(deck[0], deck[1])
    shell.lineTo(tail[0], tail[1])
    shell.quadraticCurveTo(rear - 0.04, tail[1] - 0.06, rear, 0.5)
    shell.lineTo(rear + 0.04, 0.3)
    shell.closePath()
    this.add(body, extrude(shell, BODY_WIDTH, 0.07), paint, 0, 0, 0)

    // Greenhouse: glass volume, painted roof skin and pillars.
    this.add(body, extrude(polygon(cabin.glass), CABIN_WIDTH, 0.03), glass, 0, 0, 0)
    const skin = 0.05
    this.add(
      body,
      extrude(
        polygon([
          [roofFront[0] + 0.06, roofFront[1] - 0.02],
          [roofFront[0], roofFront[1] + skin],
          [roofRear[0], roofRear[1] + skin],
          [roofRear[0] - 0.08, roofRear[1] - 0.02],
        ]),
        CABIN_WIDTH + 0.03,
        0.02,
      ),
      paint,
      0,
      0,
      0,
    )
    /** A strip along one edge of the cabin outline, on both sides of the car. */
    const pillar = (from: [number, number], to: [number, number], thickness: number) => {
      const length = Math.hypot(to[0] - from[0], to[1] - from[1])
      for (const side of [-1, 1]) {
        const mesh = this.add(
          body,
          new THREE.BoxGeometry(length + 0.04, thickness, 0.05),
          paint,
          (from[0] + to[0]) / 2,
          (from[1] + to[1]) / 2,
          side * (CABIN_WIDTH / 2),
        )
        mesh.rotation.z = Math.atan2(to[1] - from[1], to[0] - from[0])
      }
    }
    pillar(cowl, roofFront, 0.08)
    pillar(deck, roofRear, 0.12)
    const doorX = cabin.doors === 2 ? [-0.25] : []
    for (const x of doorX) pillar([x, cowl[1]], [x, roofFront[1]], 0.1)

    // Cabin interior, seen through the glass.
    this.add(body, new THREE.BoxGeometry(0.5, 0.14, CABIN_WIDTH - 0.2), interior, cowl[0] - 0.3, 0.93, 0)
    const wheelRing = this.add(body, new THREE.TorusGeometry(0.15, 0.022, 8, 20), trim, cowl[0] - 0.5, 1.02, 0.36)
    wheelRing.rotation.y = Math.PI / 2
    wheelRing.rotation.z = 0.35
    const seatRows = cabin.doors === 2 ? [0.02, -0.85] : [-0.1]
    for (const x of seatRows) {
      for (const z of [-0.36, 0.36]) {
        const back = this.add(body, new THREE.BoxGeometry(0.14, 0.42, 0.44), interior, x, 1.04, z)
        back.rotation.z = 0.16
        this.add(body, new THREE.BoxGeometry(0.11, 0.13, 0.24), interior, x - 0.05, 1.3 - (vehicle.body === 'coupe' ? 0.1 : 0), z)
      }
    }

    // Front end: grille, splitter and headlight clusters with running lights.
    const headlight = new THREE.MeshStandardMaterial({ color: 0xfff4d6, emissive: 0xfff0c4, emissiveIntensity: 2.2 })
    const runningLight = new THREE.MeshStandardMaterial({ color: 0x9fdcff, emissive: 0x9fdcff, emissiveIntensity: 1.6 })
    this.add(body, new THREE.BoxGeometry(0.06, 0.17, 0.92), trim, 2.15, 0.42, 0)
    for (let i = 0; i < 4; i++) this.add(body, new THREE.BoxGeometry(0.02, 0.012, 0.86), chrome, 2.185, 0.36 + i * 0.04, 0)
    this.add(body, new THREE.BoxGeometry(0.34, 0.05, BODY_WIDTH - 0.08), trim, 2.02, 0.19, 0)
    for (const side of [-1, 1]) {
      this.add(body, new THREE.BoxGeometry(0.1, 0.11, 0.4), trim, 2.1, 0.61, side * 0.6)
      this.add(body, new THREE.BoxGeometry(0.03, 0.07, 0.2), headlight, 2.15, 0.62, side * 0.66)
      this.add(body, new THREE.BoxGeometry(0.03, 0.02, 0.36), runningLight, 2.155, 0.56, side * 0.6)
      this.add(body, new THREE.BoxGeometry(0.05, 0.08, 0.3), trim, 2.16, 0.3, side * 0.62)
    }

    // Rear end: full-width light bar, diffuser, plate and exhaust tips.
    this.brakeLights = new THREE.MeshStandardMaterial({ color: 0x400a08, emissive: palette.red, emissiveIntensity: 0.6 })
    this.add(body, new THREE.BoxGeometry(0.04, 0.06, BODY_WIDTH - 0.3), this.brakeLights, rear - 0.01, 0.72, 0)
    for (const side of [-1, 1]) this.add(body, new THREE.BoxGeometry(0.05, 0.12, 0.3), this.brakeLights, rear, 0.7, side * 0.66)
    this.add(body, new THREE.BoxGeometry(0.3, 0.12, BODY_WIDTH - 0.3), trim, rear + 0.14, 0.24, 0)
    this.add(body, new THREE.BoxGeometry(0.02, 0.11, 0.42), new THREE.MeshStandardMaterial({ color: palette.white, roughness: 0.6 }), rear - 0.015, 0.52, 0)
    const tip = new THREE.CylinderGeometry(0.055, 0.055, 0.14, 12)
    tip.rotateZ(Math.PI / 2)
    for (const z of [-0.5, -0.36]) this.add(body, tip, chrome, rear - 0.02, 0.27, z)

    // Sides: skirts, door seams, handles, mirrors and a test number roundel.
    const number = String(this.rng.int(1, 99)).padStart(2, '0')
    const roundelCanvas = document.createElement('canvas')
    roundelCanvas.width = roundelCanvas.height = 128
    const context = roundelCanvas.getContext('2d')!
    context.fillStyle = '#eef2f6'
    context.beginPath()
    context.arc(64, 64, 62, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = '#12161a'
    context.font = '700 70px "IBM Plex Mono", ui-monospace, monospace'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(number, 64, 70)
    const roundelTexture = new THREE.CanvasTexture(roundelCanvas)
    roundelTexture.colorSpace = THREE.SRGBColorSpace
    const roundel = new THREE.MeshStandardMaterial({ map: roundelTexture, transparent: true, roughness: 0.6 })
    const sideZ = BODY_WIDTH / 2
    const seams = cabin.doors === 2 ? [0.82, -0.25, -1.0] : [0.72, -0.62]
    for (const side of [-1, 1]) {
      this.add(body, new THREE.BoxGeometry(AXLE * 2 - arch * 2 - 0.1, 0.09, 0.05), trim, 0, 0.22, side * (sideZ - 0.01))
      for (const x of seams) this.add(body, new THREE.BoxGeometry(0.014, 0.56, 0.012), trim, x, 0.58, side * sideZ)
      for (const x of seams.slice(1)) this.add(body, new THREE.BoxGeometry(0.15, 0.03, 0.03), chrome, x + 0.2, 0.76, side * (sideZ + 0.005))
      this.add(body, new THREE.BoxGeometry(0.1, 0.03, 0.14), trim, cowl[0] - 0.12, 0.95, side * (CABIN_WIDTH / 2 + 0.07))
      this.add(body, new THREE.BoxGeometry(0.13, 0.1, 0.2), paint, cowl[0] - 0.14, 0.99, side * (CABIN_WIDTH / 2 + 0.2))
      const badge = this.add(body, new THREE.CircleGeometry(0.21, 28), roundel, seams[0] - 0.52, 0.56, side * (sideZ + 0.006))
      if (side < 0) badge.rotation.y = Math.PI
    }

    // Style-specific aero.
    if (vehicle.body === 'coupe') {
      this.add(body, new THREE.BoxGeometry(0.3, 0.03, BODY_WIDTH - 0.16), trim, tail[0] + 0.02, tail[1] + 0.26, 0)
      for (const side of [-1, 1]) {
        this.add(body, new THREE.BoxGeometry(0.34, 0.12, 0.03), trim, tail[0] + 0.02, tail[1] + 0.24, side * (BODY_WIDTH / 2 - 0.08))
        this.add(body, new THREE.BoxGeometry(0.06, 0.24, 0.04), trim, tail[0] + 0.06, tail[1] + 0.12, side * 0.5)
      }
    } else if (vehicle.body === 'hatch') {
      this.add(body, new THREE.BoxGeometry(0.26, 0.04, CABIN_WIDTH), paint, roofRear[0] - 0.1, roofRear[1] + 0.05, 0)
    } else {
      this.add(body, new THREE.BoxGeometry(0.2, 0.07, 0.04), trim, roofRear[0] + 0.25, roofRear[1] + 0.09, 0)
    }
    // Roof-mounted logger box, part of the test instrumentation.
    this.add(body, new THREE.BoxGeometry(0.34, 0.07, 0.26), new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.5 }), (roofFront[0] + roofRear[0]) / 2, roofFront[1] + skin + 0.04, 0)

    // Suspension blocks close off the wheel arches from inside.
    for (const axle of [AXLE, -AXLE]) this.add(body, new THREE.BoxGeometry(0.5, 0.34, BODY_WIDTH - 0.56), trim, axle, 0.36, 0)

    this.buildWheels(trim, chrome)

    // Tie-down straps from the body corners to the deck.
    const strapMaterial = new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.8 })
    for (const along of [-1, 1]) {
      for (const side of [-1, 1]) {
        const from = new THREE.Vector3(along * 2.02, DECK + 0.3, side * 0.74)
        const to = new THREE.Vector3(along * 3.05, DECK, side * 1.35)
        const strap = this.add(this.world, new THREE.BoxGeometry(0.05, 0.02, from.distanceTo(to)), strapMaterial, 0, 0, 0)
        strap.position.copy(from).lerp(to, 0.5)
        // lookAt works in scene space; the world group is shifted down.
        strap.lookAt(to.add(this.world.position))
      }
    }

    // Exhaust extraction hose from the tailpipes to a floor duct.
    const hose = new THREE.CatmullRomCurve3([
      new THREE.Vector3(rear - 0.1, DECK + 0.27, -0.43),
      new THREE.Vector3(rear - 0.75, DECK + 0.3, -0.6),
      new THREE.Vector3(-3.7, 0.2, -1.5),
      new THREE.Vector3(-4.6, 0.3, -2.6),
    ])
    this.add(this.world, new THREE.TubeGeometry(hose, 28, 0.1, 10), new THREE.MeshStandardMaterial({ color: 0xb98a1e, roughness: 0.7 }), 0, 0, 0)
    this.add(
      this.world,
      new THREE.BoxGeometry(0.9, 0.7, 0.9),
      new THREE.MeshStandardMaterial({ color: palette.steel, metalness: 0.5, roughness: 0.5 }),
      -4.9,
      0.35,
      -2.9,
    )
    // Data cable from the roof logger to the wall display.
    const cable = new THREE.CatmullRomCurve3([
      new THREE.Vector3((roofFront[0] + roofRear[0]) / 2, DECK + roofFront[1] + 0.1, -0.13),
      new THREE.Vector3(-0.3, DECK + roofFront[1] + 0.5, -1.4),
      new THREE.Vector3(-0.6, 1.6, -2.9),
      new THREE.Vector3(-0.6, 1.5, -3.55),
    ])
    this.add(this.world, new THREE.TubeGeometry(cable, 24, 0.022, 6), trim, 0, 0, 0)
  }

  /** Alloy wheels with tyres, brake discs and fixed calipers. Only the driven pair turns. */
  private buildWheels(trim: THREE.Material, chrome: THREE.Material): void {
    const { vehicle } = this.logic
    const radius = vehicle.wheelRadius
    const width = 0.25
    // Tyre cross-section with rounded shoulders, revolved around the axle.
    const tyreGeometry = new THREE.LatheGeometry(
      [
        [radius * 0.64, -width / 2],
        [radius * 0.93, -width / 2],
        [radius, -width / 2 + 0.045],
        [radius, width / 2 - 0.045],
        [radius * 0.93, width / 2],
        [radius * 0.64, width / 2],
      ].map(([r, y]) => new THREE.Vector2(r, y)),
      28,
    )
    tyreGeometry.rotateX(Math.PI / 2)
    const barrelGeometry = new THREE.CylinderGeometry(radius * 0.66, radius * 0.66, width * 0.8, 24, 1, true)
    barrelGeometry.rotateX(Math.PI / 2)
    const discGeometry = new THREE.CylinderGeometry(radius * 0.52, radius * 0.52, 0.03, 24)
    discGeometry.rotateX(Math.PI / 2)
    const hubGeometry = new THREE.CylinderGeometry(radius * 0.16, radius * 0.16, 0.05, 12)
    hubGeometry.rotateX(Math.PI / 2)
    const spokeGeometry = new THREE.BoxGeometry(radius * 0.6, 0.035, 0.03)
    spokeGeometry.translate(radius * 0.34, 0, 0)
    const lipGeometry = new THREE.TorusGeometry(radius * 0.66, 0.014, 6, 28)

    const tyre = new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.9 })
    const barrel = new THREE.MeshStandardMaterial({ color: 0x2b3038, metalness: 0.7, roughness: 0.4, side: THREE.DoubleSide })
    const disc = new THREE.MeshStandardMaterial({ color: 0x8b95a1, metalness: 0.85, roughness: 0.35 })
    const caliper = new THREE.MeshStandardMaterial({ color: palette.red, roughness: 0.5 })

    for (const axle of [AXLE, -AXLE]) {
      for (const side of [-1, 1]) {
        const anchor = new THREE.Group()
        anchor.position.set(axle, DECK + radius - 0.03, side * (BODY_WIDTH / 2 - width / 2 + 0.01))
        this.world.add(anchor)
        const face = side * (width / 2 - 0.035)
        this.add(anchor, new THREE.BoxGeometry(0.14, 0.09, 0.07), caliper, radius * 0.3, radius * 0.36, face - side * 0.05).rotation.z = -0.7

        const group = new THREE.Group()
        anchor.add(group)
        this.add(group, tyreGeometry, tyre, 0, 0, 0)
        this.add(group, barrelGeometry, barrel, 0, 0, 0)
        this.add(group, discGeometry, disc, 0, 0, face - side * 0.06)
        this.add(group, lipGeometry, chrome, 0, 0, side * (width / 2 - 0.01))
        this.add(group, hubGeometry, trim, 0, 0, face)
        // Five split spokes.
        for (let i = 0; i < 5; i++) {
          for (const split of [-0.11, 0.11]) {
            this.add(group, spokeGeometry, chrome, 0, 0, face).rotation.z = (i / 5) * Math.PI * 2 + split
          }
        }
        this.wheels.push({ group, driven: (axle > 0) === (vehicle.drivenAxle === 'front') })
      }
    }
  }

  /** Cooling fan in front of the car; it also drives the airflow streaks. */
  private buildFan(): void {
    const frame = new THREE.MeshStandardMaterial({ color: 0x39505e, metalness: 0.4, roughness: 0.5, side: THREE.DoubleSide })
    const shroud = new THREE.CylinderGeometry(1.05, 1.05, 0.6, 28, 1, true)
    shroud.rotateZ(Math.PI / 2)
    this.add(this.world, shroud, frame, 4.9, 1.45, 0)
    this.add(this.world, new THREE.BoxGeometry(0.7, 0.4, 1.8), frame, 4.9, 0.2, 0)

    this.fan = new THREE.Group()
    this.fan.position.set(4.9, 1.45, 0)
    const blade = new THREE.BoxGeometry(0.05, 1.9, 0.3)
    const bladeMaterial = new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.6, roughness: 0.35 })
    for (let i = 0; i < 3; i++) this.add(this.fan, blade, bladeMaterial, 0, 0, 0).rotation.x = (i * Math.PI) / 3
    const hub = new THREE.CylinderGeometry(0.22, 0.22, 0.3, 12)
    hub.rotateZ(Math.PI / 2)
    this.add(this.fan, hub, new THREE.MeshStandardMaterial({ color: palette.cyan, roughness: 0.5 }), 0, 0, 0)
    this.world.add(this.fan)
  }

  /** Wall display behind the car showing the live speed trace against the cycle target. */
  private buildReadout(): void {
    const canvas = document.createElement('canvas')
    canvas.width = 384
    canvas.height = 192
    this.graphContext = canvas.getContext('2d')!
    this.graphTexture = new THREE.CanvasTexture(canvas)
    this.graphTexture.colorSpace = THREE.SRGBColorSpace
    this.drawGraph()

    const frame = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.5, roughness: 0.5 })
    this.add(this.world, new THREE.BoxGeometry(3.5, 1.8, 0.14), frame, -0.6, 2.2, -3.6)
    this.add(
      this.world,
      new THREE.PlaneGeometry(3.3, 1.6),
      new THREE.MeshBasicMaterial({ map: this.graphTexture, toneMapped: false }),
      -0.6,
      2.2,
      -3.52,
    )
    for (const side of [-1, 1]) this.add(this.world, new THREE.BoxGeometry(0.14, 1.4, 0.14), frame, -0.6 + side * 1.4, 0.7, -3.6)
  }

  private drawGraph(): void {
    const context = this.graphContext
    const { logic } = this
    const { width, height } = context.canvas
    const top = 46
    const maxSpeed = 45
    context.fillStyle = '#070a0d'
    context.fillRect(0, 0, width, height)
    context.strokeStyle = '#1d252e'
    context.lineWidth = 1
    for (let i = 0; i <= 4; i++) {
      const y = top + ((height - top - 8) * i) / 4
      context.beginPath()
      context.moveTo(0, y)
      context.lineTo(width, y)
      context.stroke()
    }
    const plot = (key: 'speed' | 'target', color: string, lineWidth: number) => {
      context.strokeStyle = color
      context.lineWidth = lineWidth
      context.beginPath()
      this.history.forEach((sample, i) => {
        const x = (i / (GRAPH_SECONDS * GRAPH_RATE - 1)) * width
        const y = height - 8 - Math.min(1, sample[key] / maxSpeed) * (height - top - 8)
        if (i === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      })
      context.stroke()
    }
    if (logic.params.mode === 'cycle' && !logic.powerRun) plot('target', '#4cc9f0', 2)
    plot('speed', '#ffb020', 3)

    context.font = '600 30px "IBM Plex Mono", ui-monospace, monospace'
    context.fillStyle = '#eef2f6'
    context.fillText(`${(logic.rollerSpeed * 3.6).toFixed(0).padStart(3, '0')} km/h`, 12, 34)
    context.fillStyle = '#ffb020'
    context.fillText(`G${logic.gear + 1}`, 220, 34)
    context.fillStyle = '#7a8591'
    context.font = '500 18px "IBM Plex Mono", ui-monospace, monospace'
    context.fillText(logic.powerRun ? 'POWER RUN' : logic.params.mode === 'cycle' ? 'CYCLE' : 'MANUAL', 276, 30)
    this.graphTexture.needsUpdate = true
  }

  /** Seeded workshop props around the rig. */
  private buildDressing(): void {
    const tyre = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 16)
    const tyreMaterial = new THREE.MeshStandardMaterial({ color: 0x14171b, roughness: 0.85 })
    const stacks = this.rng.int(1, 3)
    for (let i = 0; i < stacks; i++) {
      const x = 2.2 + i * 0.85
      const height = this.rng.int(2, 4)
      for (let level = 0; level < height; level++) {
        this.add(this.world, tyre, tyreMaterial, x + this.rng.range(-0.04, 0.04), 0.12 + level * 0.25, -3.5 + this.rng.range(-0.04, 0.04))
      }
    }
    // Tool cart.
    const cartX = this.rng.range(-4.6, -3.6)
    const cart = new THREE.MeshStandardMaterial({ color: palette.red, metalness: 0.3, roughness: 0.5 })
    this.add(this.world, new THREE.BoxGeometry(1.1, 0.9, 0.6), cart, cartX, 0.55, 2.9)
    for (let drawer = 0; drawer < 3; drawer++) {
      this.add(
        this.world,
        new THREE.BoxGeometry(0.9, 0.04, 0.02),
        new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.6, roughness: 0.4 }),
        cartX,
        0.3 + drawer * 0.26,
        3.21,
      )
    }
    const drum = new THREE.CylinderGeometry(0.32, 0.32, 0.9, 14)
    const drumCount = this.rng.int(1, 3)
    for (let i = 0; i < drumCount; i++) {
      this.add(
        this.world,
        drum,
        new THREE.MeshStandardMaterial({ color: this.rng.pick([palette.cyan, palette.amber, palette.steel]), metalness: 0.35, roughness: 0.55 }),
        4.6 + i * 0.75,
        0.45,
        -3.4,
      )
    }
  }

  private buildEffects(): void {
    const streakCount = this.isPreview ? 22 : 54
    this.streaks = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.6, 0.012, 0.012),
      new THREE.MeshBasicMaterial({ color: palette.cyan, transparent: true, opacity: 0.55, depthWrite: false }),
      streakCount,
    )
    this.streaks.frustumCulled = false
    this.streakState = Array.from({ length: streakCount }, () => ({
      x: this.fx.range(-3.6, 4.4),
      y: this.fx.range(0.75, 2.15),
      z: this.fx.range(-0.95, 0.95),
    }))

    const puffCount = this.isPreview ? 16 : 48
    this.smoke = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.2, 1),
      new THREE.MeshBasicMaterial({ color: 0xaab4bf, transparent: true, opacity: 0.32, depthWrite: false }),
      puffCount,
    )
    this.smoke.frustumCulled = false
    this.smokeState = Array.from({ length: puffCount }, () => ({ x: 0, y: 0, z: 0, age: 1, life: 1 }))
    this.world.add(this.streaks, this.smoke)
    this.updateStreaks(0, 0)
    this.updateSmoke(0)
  }

  /** Height of the car's upper surface at a position along its length. */
  private roofHeight(x: number): number {
    const points = this.roof
    if (x <= points[0][0] || x >= points[points.length - 1][0]) return 0
    for (let i = 1; i < points.length; i++) {
      if (x <= points[i][0]) {
        const [x0, y0] = points[i - 1]
        const [x1, y1] = points[i]
        return y0 + ((y1 - y0) * (x - x0)) / Math.max(x1 - x0, 1e-6)
      }
    }
    return 0
  }

  /** Airflow streaks leave the fan and ride up over the car body. */
  private updateStreaks(dt: number, airspeed: number): void {
    const visible = airspeed > 0.5
    const length = THREE.MathUtils.clamp(airspeed / 18, 0.25, 1.7)
    this.streakState.forEach((streak, i) => {
      streak.x -= airspeed * 0.22 * dt
      if (streak.x < -3.6) {
        streak.x = 4.4
        streak.y = this.fx.range(0.75, 2.15)
        streak.z = this.fx.range(-0.95, 0.95)
      }
      const overCar = Math.abs(streak.z) < BODY_WIDTH / 2 + 0.1 ? this.roofHeight(streak.x) : 0
      const y = Math.max(streak.y, overCar > 0 ? DECK + overCar + 0.1 + (streak.y - 0.75) * 0.25 : 0)
      this.position.set(streak.x, y, streak.z)
      this.scale.set(visible ? length : 0, 1, 1)
      this.matrix.compose(this.position, this.rotation, this.scale)
      this.streaks.setMatrixAt(i, this.matrix)
    })
    this.streaks.instanceMatrix.needsUpdate = true
  }

  /** Tyre smoke: pooled puffs spawned at the driven wheels in proportion to slip. */
  private updateSmoke(dt: number): void {
    const { logic } = this
    const drivenX = logic.vehicle.drivenAxle === 'front' ? AXLE : -AXLE
    this.smokeDebt += Math.max(0, logic.slip - 0.15) * 70 * dt
    this.smokeState.forEach((puff, i) => {
      if (puff.age >= puff.life && this.smokeDebt >= 1) {
        this.smokeDebt -= 1
        puff.age = 0
        puff.life = this.fx.range(0.7, 1.4)
        puff.x = drivenX - 0.35 + this.fx.range(-0.1, 0.1)
        puff.y = DECK + 0.1
        puff.z = (this.fx.chance(0.5) ? 1 : -1) * TRACK + this.fx.range(-0.1, 0.1)
      }
      let size = 0
      if (puff.age < puff.life) {
        puff.age += dt
        puff.x -= dt * 1.1
        puff.y += dt * 0.7
        const t = puff.age / puff.life
        size = Math.sin(Math.min(1, t) * Math.PI) * (0.8 + t * 2.2)
      }
      this.position.set(puff.x, puff.y, puff.z)
      this.scale.setScalar(size)
      this.matrix.compose(this.position, this.rotation, this.scale)
      this.smoke.setMatrixAt(i, this.matrix)
    })
    this.smokeDebt = Math.min(this.smokeDebt, 4)
    this.smoke.instanceMatrix.needsUpdate = true
  }
}
