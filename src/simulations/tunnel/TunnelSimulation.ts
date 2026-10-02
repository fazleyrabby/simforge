import * as THREE from 'three'
import { makeIsoCamera } from '../../three/cameras'
import { mergeStaticMeshes } from '../../three/merge'
import { palette } from '../../three/palette'
import { makePlinth } from '../../three/plinth'
import { BaseSimulation } from '../core/BaseSimulation'
import { Rng } from '../core/random'
import { STEP, type ParamValue, type StatValue } from '../core/Simulation'
import { FluidGrid, shapeOutline, type ShapeKind } from './FluidGrid'

/** The test section: the slice of air being simulated, standing upright along the tunnel. */
const LENGTH = 12
const HEIGHT = 6
const DEPTH = 3.2
const FLOOR = 1.6
const TOP = FLOOR + HEIGHT
const MID = FLOOR + HEIGHT / 2
const SPAN = 2.6
const FRONT = DEPTH / 2
const STALL_ANGLE = 15

/** Liquid columns on the manometer board, one per pressure tap above the model. */
const TAPS = 10
const TUBE_HEIGHT = 1
const GRAPH_SAMPLES = 120
const TUFT_LENGTH = 0.3
/** The operator's console stands clear of the cabinet, off to the inlet side. */
const DESK_X = -7.4
const DESK_Z = FRONT + 3.1

type View = 'smoke' | 'speed' | 'pressure' | 'vorticity'

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Points spaced evenly round a closed outline, with the outward direction at each. */
function perimeterSamples(outline: [number, number][], spacing: number): { x: number; y: number; nx: number; ny: number }[] {
  const samples: { x: number; y: number; nx: number; ny: number }[] = []
  // Signed area tells which way the outline winds, so normals can point outward.
  let area = 0
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i]
    const [x1, y1] = outline[(i + 1) % outline.length]
    area += x0 * y1 - x1 * y0
  }
  const side = area > 0 ? 1 : -1
  let carry = spacing / 2
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i]
    const [x1, y1] = outline[(i + 1) % outline.length]
    const length = Math.hypot(x1 - x0, y1 - y0)
    if (length < 1e-6) continue
    const tx = (x1 - x0) / length
    const ty = (y1 - y0) / length
    while (carry <= length) {
      samples.push({ x: x0 + tx * carry, y: y0 + ty * carry, nx: ty * side, ny: -tx * side })
      carry += spacing
    }
    carry -= length
  }
  return samples
}

/** A tracer speck carried by the flow. Position is in grid cells. */
interface Tracer {
  x: number
  y: number
  age: number
  life: number
}

/** A wool tuft taped to the model: where it sits and where it reads the air. */
interface Tuft {
  x: number
  y: number
  cell: number
  phase: number
}

export default class TunnelSimulation extends BaseSimulation {
  private grid!: FluidGrid
  /** Randomness for appearance only; never feeds the simulation. */
  private fx = new Rng(1)
  private pixels = new Uint8Array(0)
  private texture: THREE.DataTexture | null = null
  private model: THREE.Group | null = null
  private modelMaterial!: THREE.MeshPhysicalMaterial
  private fan!: THREE.Group
  private pointerDisc!: THREE.Mesh
  private liftArrow!: THREE.Group
  private dragArrow!: THREE.Group
  private stalled = false

  private tracers: Tracer[] = []
  private tracerMesh!: THREE.InstancedMesh
  private tufts: Tuft[] = []
  private tuftMesh!: THREE.InstancedMesh
  /** Outward direction of the skin at each tuft, in the model's own frame. */
  private tuftNormals: number[][] = []
  private liquid!: THREE.InstancedMesh
  private tapCells: number[] = []
  private tapLevels = new Float32Array(TAPS).fill(0.5)
  private history: { lift: number; drag: number }[] = []
  private sampleTimer = 0
  private graph: { texture: THREE.CanvasTexture; context: CanvasRenderingContext2D } | null = null
  private sign: { texture: THREE.CanvasTexture; context: CanvasRenderingContext2D; shown: string } | null = null

  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private hit = new THREE.Vector3()
  private slice = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
  private drag: { pointerId: number; x: number; y: number } | null = null
  private matrix = new THREE.Matrix4()
  private position = new THREE.Vector3()
  private scale = new THREE.Vector3()
  private quaternion = new THREE.Quaternion()
  private axisZ = new THREE.Vector3(0, 0, 1)

  constructor() {
    super(makeIsoCamera(new THREE.Vector3(0.5, 0.42, 1)))
    this.params = { shape: 'airfoil', angle: 12, wind: 22, turbulence: 0.35, view: 'smoke', tracers: true }
  }

  protected build(): void {
    // Coarser air on previews and low-spec devices: the solver is the cost here.
    const [width, height, sweeps] = this.isPreview ? [64, 32, 24] : this.ctx.mobile ? [72, 36, 30] : [96, 48, 40]
    this.grid = new FluidGrid(width, height, this.rng, this.readParams(), sweeps)
    this.grid.setBody(this.shape(), this.num('angle'))
    this.fx = new Rng(this.seed + 5)
    this.stalled = false
    this.drag = null
    this.history = []
    this.sampleTimer = 0
    this.tapLevels.fill(0.5)
    this.world.position.y = -(MID + 0.4)

    const floor = makePlinth(LENGTH + 12, DEPTH + 7.4)
    floor.position.z = 1
    this.world.add(floor)
    this.buildTestSection()
    this.buildInlet()
    this.buildOutlet()
    this.buildCabinet()
    this.buildRoom()
    mergeStaticMeshes(this.world)

    this.buildFan()
    this.buildInstruments()
    this.buildFlowPlane()
    this.buildTracers()
    this.buildArrows()
    this.buildModel()

    this.enableShadows(this.world)
    this.tracerMesh.castShadow = false
    this.lighting.setShadowExtent(15)
    this.setView(LENGTH * 0.5 + (this.isPreview ? 3.4 : 6.2), HEIGHT * 0.5 + (this.isPreview ? 1.9 : 3.6))

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
    this.texture = null
    this.model = null
    this.graph = null
    this.sign = null
    const element = this.ctx?.element
    if (!element) return
    element.removeEventListener('pointerdown', this.onPointerDown, true)
    element.removeEventListener('pointermove', this.onPointerMove, true)
    element.removeEventListener('pointerup', this.onPointerUp, true)
    element.removeEventListener('pointercancel', this.onPointerUp, true)
  }

  protected update(dt: number): void {
    const { grid } = this
    grid.step(dt)
    this.fan.rotation.x += (2 + this.num('wind') * 0.9) * dt
    this.advectTracers(dt)

    // Manometer columns ease toward the pressure at their taps: suction pulls the liquid up.
    const wind = Math.max(this.num('wind'), 1e-6)
    const scale = 1 / (STEP * 0.5 * wind * wind)
    for (let i = 0; i < TAPS; i++) {
      const coefficient = grid.pressure[this.tapCells[i]] * scale
      const target = THREE.MathUtils.clamp(0.5 - coefficient * 0.3, 0.06, 0.98)
      this.tapLevels[i] += (target - this.tapLevels[i]) * Math.min(1, dt * 4)
    }

    this.sampleTimer += dt
    if (this.sampleTimer >= 0.1) {
      this.sampleTimer = 0
      this.history.push({ lift: grid.lift, drag: grid.drag })
      if (this.history.length > GRAPH_SAMPLES) this.history.shift()
      this.drawGraph()
      this.drawSign()
    }
  }

  render(_alpha: number): void {
    this.paintFlow()
    this.paintTracers()
    this.paintTufts()
    this.paintManometer()
    // Arrows grow from the model with the measured forces: lift up (or down), drag downstream.
    const { lift, drag } = this.grid
    this.liftArrow.scale.y = THREE.MathUtils.clamp(lift * 2.6, -3, 3) || 0.001
    this.dragArrow.scale.y = THREE.MathUtils.clamp(drag * 2.6, 0.001, 4)
    this.liftArrow.visible = Math.abs(lift) > 0.02
    this.dragArrow.visible = drag > 0.02
  }

  protected onParam(key: string, _value: ParamValue): void {
    if (key === 'shape' || key === 'angle') {
      this.grid.setBody(this.shape(), this.num('angle'))
      if (key === 'shape') this.buildModel()
      else this.poseModel()
      this.checkStall()
    } else {
      this.grid.params = this.readParams()
    }
  }

  action(key: string): void {
    if (key === 'burst') this.grid.burst()
  }

  getStats(): Record<string, StatValue> {
    const { grid } = this
    const ratio = Math.abs(grid.drag) > 0.01 ? grid.lift / grid.drag : 0
    return {
      wind: this.num('wind').toFixed(0),
      lift: grid.lift.toFixed(2),
      drag: grid.drag.toFixed(2),
      ratio: ratio.toFixed(1),
      peak: `${grid.peakSpeed().toFixed(2)}×`,
      grid: `${grid.width} × ${grid.height}`,
    }
  }

  entityCount(): number {
    return this.grid.width * this.grid.height + this.tracers.length
  }

  private readParams() {
    return { wind: this.num('wind'), turbulence: this.num('turbulence') }
  }

  private shape(): ShapeKind {
    return this.params.shape as ShapeKind
  }

  /** World position of a point given in grid cells. */
  private gridToWorld(x: number, y: number): [number, number] {
    return [(x / this.grid.width - 0.5) * LENGTH, FLOOR + (y / this.grid.height) * HEIGHT]
  }

  private checkStall(): void {
    const stalled = this.shape() === 'airfoil' && Math.abs(this.num('angle')) >= STALL_ANGLE
    if (stalled && !this.stalled) {
      this.events.emit({
        type: 'flow_separation',
        level: 'warn',
        title: 'FLOW SEPARATION',
        message: 'Pitched this steeply, the air can no longer follow the wing. A wake opens behind it and drag climbs.',
      })
    }
    this.stalled = stalled
  }

  private add(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(x, y, z)
    parent.add(mesh)
    return mesh
  }

  /** A rectangular hoop standing across the tunnel at x: a flange or stiffening rib. */
  private rib(x: number, halfHeight: number, halfDepth: number, thickness: number, material: THREE.Material): void {
    this.add(this.world, new THREE.BoxGeometry(thickness, thickness, halfDepth * 2 + thickness), material, x, MID + halfHeight, 0)
    this.add(this.world, new THREE.BoxGeometry(thickness, thickness, halfDepth * 2 + thickness), material, x, MID - halfHeight, 0)
    this.add(this.world, new THREE.BoxGeometry(thickness, halfHeight * 2 + thickness, thickness), material, x, MID, halfDepth)
    this.add(this.world, new THREE.BoxGeometry(thickness, halfHeight * 2 + thickness, thickness), material, x, MID, -halfDepth)
  }

  /** A text plate drawn once onto a canvas. */
  private label(text: string, width: number, height: number, color: string, background: string): THREE.MeshBasicMaterial {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = Math.round((512 * height) / width)
    const context = canvas.getContext('2d')!
    context.fillStyle = background
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = color
    context.font = `600 ${Math.round(canvas.height * 0.46)}px "IBM Plex Mono", ui-monospace, monospace`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(text, canvas.width / 2, canvas.height / 2 + 2)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })
  }

  /** Glass-walled working section: frame, back wall with protractor, lighting, laser sheet and probes. */
  private buildTestSection(): void {
    const frame = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.6, roughness: 0.4 })
    const light = new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.75, roughness: 0.3 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x0b0e12, roughness: 0.9 })

    this.add(this.world, new THREE.BoxGeometry(LENGTH, 0.3, DEPTH), frame, 0, FLOOR - 0.15, 0)
    this.add(this.world, new THREE.BoxGeometry(LENGTH, 0.16, DEPTH), frame, 0, TOP + 0.08, 0)
    this.add(this.world, new THREE.BoxGeometry(LENGTH, HEIGHT, 0.08), dark, 0, MID, -FRONT)
    // Reference grid on the back wall.
    const gridLine = new THREE.MeshBasicMaterial({ color: 0x1c2630 })
    for (let i = 1; i < 6; i++) this.add(this.world, new THREE.BoxGeometry(LENGTH, 0.02, 0.02), gridLine, 0, FLOOR + i, -FRONT + 0.06)
    for (let i = 1; i < 12; i++) this.add(this.world, new THREE.BoxGeometry(0.02, HEIGHT, 0.02), gridLine, -LENGTH / 2 + i, MID, -FRONT + 0.06)

    // Corner posts, a centre mullion and bolted flanges where the section joins its neighbours.
    for (const x of [-LENGTH / 2, LENGTH / 2]) {
      for (const z of [-FRONT, FRONT]) this.add(this.world, new THREE.BoxGeometry(0.18, HEIGHT + 0.46, 0.18), frame, x, MID, z)
      this.rib(x, HEIGHT / 2 + 0.2, FRONT + 0.12, 0.2, light)
    }
    const bolt = new THREE.CylinderGeometry(0.045, 0.045, 0.3, 6)
    bolt.rotateZ(Math.PI / 2)
    const bolts = new THREE.InstancedMesh(bolt, frame, 2 * 14)
    let slot = 0
    for (const x of [-LENGTH / 2, LENGTH / 2]) {
      for (let i = 0; i < 14; i++) {
        this.matrix.makeTranslation(x, FLOOR + 0.25 + i * ((HEIGHT - 0.5) / 13), FRONT + 0.12)
        bolts.setMatrixAt(slot++, this.matrix)
      }
    }
    this.world.add(bolts)

    // Front window with an access door: frame, hinges and a latch handle.
    this.add(
      this.world,
      new THREE.BoxGeometry(LENGTH, HEIGHT, 0.04),
      new THREE.MeshPhysicalMaterial({ color: 0xbfe0f0, roughness: 0.05, transparent: true, opacity: 0.07, depthWrite: false }),
      0,
      MID,
      FRONT,
    )
    const doorLeft = -1.2
    const doorRight = 4.6
    for (const x of [doorLeft, doorRight]) this.add(this.world, new THREE.BoxGeometry(0.09, HEIGHT - 0.5, 0.09), light, x, MID, FRONT + 0.03)
    for (const y of [FLOOR + 0.25, TOP - 0.25]) {
      this.add(this.world, new THREE.BoxGeometry(doorRight - doorLeft + 0.09, 0.09, 0.09), light, (doorLeft + doorRight) / 2, y, FRONT + 0.03)
    }
    for (const y of [FLOOR + 1.2, TOP - 1.2]) this.add(this.world, new THREE.BoxGeometry(0.16, 0.42, 0.14), frame, doorRight + 0.05, y, FRONT + 0.06)
    this.add(this.world, new THREE.BoxGeometry(0.1, 0.7, 0.16), new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.5 }), doorLeft + 0.22, MID, FRONT + 0.1)

    // Scale marks along the sill.
    const ticks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.02, 1, 0.02), new THREE.MeshBasicMaterial({ color: 0x8b95a1 }), 49)
    for (let i = 0; i < 49; i++) {
      const tall = i % 4 === 0
      this.position.set(-LENGTH / 2 + i * 0.25, FLOOR + 0.02 + (tall ? 0.1 : 0.05), FRONT - 0.04)
      this.matrix.compose(this.position, this.quaternion, this.scale.set(1, tall ? 0.2 : 0.1, 1))
      ticks.setMatrixAt(i, this.matrix)
    }
    this.world.add(ticks)

    // Light bar and the laser that lights the slice of air being shown.
    this.add(
      this.world,
      new THREE.BoxGeometry(LENGTH - 1, 0.06, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x1a222b, emissive: 0xcfe6ff, emissiveIntensity: 1.3 }),
      0,
      TOP - 0.05,
      FRONT - 0.4,
    )
    const laser = new THREE.MeshStandardMaterial({ color: 0x06140a, emissive: palette.green, emissiveIntensity: 2.2 })
    this.add(this.world, new THREE.BoxGeometry(0.7, 0.34, 0.5), frame, 1.5, TOP + 0.33, 0)
    this.add(this.world, new THREE.BoxGeometry(0.3, 0.05, 0.05), laser, 1.5, TOP + 0.02, 0)
    this.add(this.world, new THREE.BoxGeometry(LENGTH - 0.4, 0.015, 0.015), laser, 0, TOP - 0.01, 0)

    // Pitot probe upstream of the model, with its line up through the roof.
    const [modelX] = this.gridToWorld(this.grid.centerX, 0)
    const probeX = -LENGTH / 2 + 1.5
    this.add(this.world, new THREE.CylinderGeometry(0.035, 0.035, 1.5, 8), light, probeX, TOP - 0.75, -0.7)
    const tip = new THREE.CylinderGeometry(0.03, 0.03, 0.6, 8)
    tip.rotateZ(Math.PI / 2)
    this.add(this.world, tip, light, probeX - 0.3, TOP - 1.5, -0.7)
    this.add(this.world, new THREE.BoxGeometry(0.26, 0.2, 0.26), frame, probeX, TOP + 0.26, -0.7)

    // Protractor on the back wall behind the model, and the shaft the model turns on.
    const dial = document.createElement('canvas')
    dial.width = dial.height = 256
    const context = dial.getContext('2d')!
    context.translate(128, 128)
    context.strokeStyle = '#5a6a7a'
    context.lineWidth = 2
    context.beginPath()
    context.arc(0, 0, 120, 0, Math.PI * 2)
    context.stroke()
    for (let degrees = 0; degrees < 360; degrees += 5) {
      const major = degrees % 30 === 0
      const angle = (degrees * Math.PI) / 180
      context.lineWidth = major ? 3 : 1
      context.beginPath()
      context.moveTo(Math.cos(angle) * (major ? 98 : 108), Math.sin(angle) * (major ? 98 : 108))
      context.lineTo(Math.cos(angle) * 120, Math.sin(angle) * 120)
      context.stroke()
    }
    const dialTexture = new THREE.CanvasTexture(dial)
    dialTexture.colorSpace = THREE.SRGBColorSpace
    this.add(
      this.world,
      new THREE.CircleGeometry(2.1, 48),
      new THREE.MeshBasicMaterial({ map: dialTexture, transparent: true, toneMapped: false }),
      modelX,
      MID,
      -FRONT + 0.07,
    )
    const shaft = new THREE.CylinderGeometry(0.09, 0.09, FRONT + 0.6, 12)
    shaft.rotateX(Math.PI / 2)
    this.add(this.world, shaft, light, modelX, MID, -(FRONT + 0.6) / 2 - 0.2)
    this.add(this.world, new THREE.BoxGeometry(0.9, 0.9, 0.7), frame, modelX, MID, -FRONT - 0.42)
  }

  /** Bell-mouth contraction with flow-straightening screens, the smoke rake and its generator. */
  private buildInlet(): void {
    const frame = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.6, roughness: 0.4 })
    const light = new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.75, roughness: 0.3 })
    const shell = new THREE.MeshStandardMaterial({ color: 0x39505e, metalness: 0.4, roughness: 0.5, side: THREE.DoubleSide })
    const accent = new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.6 })
    const length = 3.6
    const mouthX = -LENGTH / 2 - length
    // Half-height of the square duct at the mouth and at the test section.
    const mouth = HEIGHT * 0.66
    const throat = HEIGHT / 2

    const contraction = new THREE.CylinderGeometry(throat * Math.SQRT2, mouth * Math.SQRT2, length, 4, 1, true)
    contraction.rotateY(Math.PI / 4)
    contraction.rotateZ(-Math.PI / 2)
    contraction.scale(1, 1, DEPTH / HEIGHT)
    this.add(this.world, contraction, shell, -LENGTH / 2 - length / 2, MID, 0)
    // Stiffening ribs and the rolled lip of the mouth.
    for (const t of [0.33, 0.66]) {
      const half = lerp(mouth, throat, t)
      this.rib(mouthX + length * t, half + 0.05, (half * DEPTH) / HEIGHT + 0.05, 0.12, frame)
    }
    this.rib(mouthX, mouth + 0.08, (mouth * DEPTH) / HEIGHT + 0.08, 0.3, accent)

    // Honeycomb and a fine mesh screen: both are grids with alpha cut-outs.
    const honeycomb = (cells: number, line: number, x: number, color: string) => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 64
      const context = canvas.getContext('2d')!
      context.strokeStyle = color
      context.lineWidth = line
      context.strokeRect(0, 0, 64, 64)
      const texture = new THREE.CanvasTexture(canvas)
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping
      texture.repeat.set(cells, Math.round((cells * DEPTH) / HEIGHT))
      texture.colorSpace = THREE.SRGBColorSpace
      const half = lerp(mouth, throat, (x - mouthX) / length) - 0.06
      const plane = this.add(
        this.world,
        new THREE.PlaneGeometry((half * 2 * DEPTH) / HEIGHT, half * 2),
        new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.5, transparent: true, side: THREE.DoubleSide }),
        x,
        MID,
        0,
      )
      plane.rotation.y = Math.PI / 2
    }
    honeycomb(14, 10, mouthX + 0.12, '#6f8090')
    honeycomb(30, 6, mouthX + 0.9, '#3d4b58')

    // Smoke rake: one nozzle per smoke line, fed from a manifold.
    const rakeX = -LENGTH / 2 + 0.12
    this.add(this.world, new THREE.BoxGeometry(0.12, HEIGHT, 0.12), frame, rakeX, MID, 0)
    const spacing = Math.max(4, Math.round(this.grid.height / 12))
    const nozzle = new THREE.CylinderGeometry(0.045, 0.075, 0.34, 8)
    nozzle.rotateZ(-Math.PI / 2)
    for (let row = Math.round(spacing * 0.15); row < this.grid.height; row += spacing) {
      const [, y] = this.gridToWorld(0, row + 0.5)
      this.add(this.world, nozzle, accent, rakeX + 0.2, y, 0)
    }
    // Smoke generator on the floor, with its feed hose up to the rake.
    const tankX = -LENGTH / 2 + 0.6
    const tankZ = FRONT + 1.5
    this.add(this.world, new THREE.CylinderGeometry(0.42, 0.42, 1.2, 18), light, tankX, 0.6, tankZ)
    this.add(this.world, new THREE.SphereGeometry(0.42, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), light, tankX, 1.2, tankZ)
    this.add(this.world, new THREE.BoxGeometry(0.7, 0.5, 0.6), frame, tankX + 0.75, 0.25, tankZ)
    this.add(this.world, new THREE.CylinderGeometry(0.16, 0.16, 0.06, 14), accent, tankX, 1.66, tankZ)
    const hose = new THREE.CatmullRomCurve3([
      new THREE.Vector3(tankX, 1.6, tankZ),
      new THREE.Vector3(tankX - 0.3, 2.6, tankZ - 0.3),
      new THREE.Vector3(rakeX - 0.2, TOP + 0.8, FRONT + 0.2),
      new THREE.Vector3(rakeX, TOP + 0.5, 0.3),
      new THREE.Vector3(rakeX, TOP + 0.1, 0),
    ])
    this.add(this.world, new THREE.TubeGeometry(hose, 36, 0.06, 8), new THREE.MeshStandardMaterial({ color: 0x15191e, roughness: 0.7 }), 0, 0, 0)

    for (const x of [mouthX + 0.5, mouthX + length - 0.6]) {
      for (const z of [-1, 1]) this.add(this.world, new THREE.BoxGeometry(0.2, FLOOR + 0.4, 0.2), frame, x, (FLOOR + 0.4) / 2, z * 1.3)
    }
  }

  /** Diffuser, fan housing with stator vanes and guard, and the drive motor. */
  private buildOutlet(): void {
    const frame = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.6, roughness: 0.4 })
    const light = new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.75, roughness: 0.3 })
    const shell = new THREE.MeshStandardMaterial({ color: 0x39505e, metalness: 0.4, roughness: 0.5, side: THREE.DoubleSide })
    const accent = new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.6 })
    const throat = HEIGHT / 2
    const wide = HEIGHT * 0.58
    const length = 2.6
    const radius = 3.1

    const diffuser = new THREE.CylinderGeometry(wide * Math.SQRT2, throat * Math.SQRT2, length, 4, 1, true)
    diffuser.rotateY(Math.PI / 4)
    diffuser.rotateZ(-Math.PI / 2)
    diffuser.scale(1, 1, DEPTH / HEIGHT)
    this.add(this.world, diffuser, shell, LENGTH / 2 + length / 2, MID, 0)
    this.rib(LENGTH / 2 + length * 0.5, lerp(throat, wide, 0.5) + 0.05, (lerp(throat, wide, 0.5) * DEPTH) / HEIGHT + 0.05, 0.12, frame)

    const fanX = LENGTH / 2 + length + 0.8
    const housing = new THREE.CylinderGeometry(radius, radius, 1.6, 36, 1, true)
    housing.rotateZ(Math.PI / 2)
    this.add(this.world, housing, shell, fanX, MID, 0)
    // Flange rings at both ends of the housing and a warning band round the blade path.
    for (const [x, material, tube] of [
      [fanX - 0.8, frame, 0.09],
      [fanX + 0.8, frame, 0.09],
      [fanX + 0.1, accent, 0.05],
    ] as [number, THREE.Material, number][]) {
      this.add(this.world, new THREE.TorusGeometry(radius + 0.02, tube, 8, 44), material, x, MID, 0).rotation.y = Math.PI / 2
    }
    // Stator vanes hold the motor pod in the airstream behind the fan.
    for (let i = 0; i < 3; i++) {
      const vane = this.add(this.world, new THREE.BoxGeometry(0.5, radius * 2 - 0.1, 0.06), frame, fanX - 0.35, MID, 0)
      vane.rotation.x = (i * Math.PI) / 3
    }
    const pod = new THREE.CylinderGeometry(0.55, 0.4, 1.3, 16)
    pod.rotateZ(Math.PI / 2)
    this.add(this.world, pod, frame, fanX - 0.5, MID, 0)
    // Guard: rings and spokes across the outlet.
    for (const ring of [1, 1.9, 2.75]) {
      this.add(this.world, new THREE.TorusGeometry(ring, 0.025, 6, 40), light, fanX + 0.82, MID, 0).rotation.y = Math.PI / 2
    }
    for (let i = 0; i < 6; i++) {
      const spoke = this.add(this.world, new THREE.BoxGeometry(0.03, radius * 2, 0.03), light, fanX + 0.82, MID, 0)
      spoke.rotation.x = (i * Math.PI) / 6
    }

    // Cradle under the housing, with cross bracing.
    for (const x of [fanX - 0.55, fanX + 0.55]) {
      for (const z of [-1, 1]) this.add(this.world, new THREE.BoxGeometry(0.22, MID - radius + 0.5, 0.22), frame, x, (MID - radius + 0.5) / 2, z * 1.5)
      this.add(this.world, new THREE.BoxGeometry(0.16, 0.16, 3.2), frame, x, 0.7, 0)
    }
    // Variable-speed drive cabinet beside the fan.
    this.add(this.world, new THREE.BoxGeometry(1, 1.9, 0.7), new THREE.MeshStandardMaterial({ color: 0x4d5863, metalness: 0.4, roughness: 0.55 }), fanX + 0.2, 0.95, FRONT + 1.7)
    this.add(this.world, new THREE.BoxGeometry(0.5, 0.26, 0.03), new THREE.MeshStandardMaterial({ color: 0x06140f, emissive: palette.green, emissiveIntensity: 1 }), fanX + 0.2, 1.5, FRONT + 2.06)
    for (let i = 0; i < 3; i++) {
      this.add(this.world, new THREE.CylinderGeometry(0.06, 0.06, 0.05, 10), i === 0 ? accent : light, fanX - 0.05 + i * 0.25, 1.1, FRONT + 2.07).rotation.x = Math.PI / 2
    }
  }

  /** Equipment cabinet under the test section: nameplate, vents and the manometer board. */
  private buildCabinet(): void {
    const frame = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.6, roughness: 0.4 })
    const panel = new THREE.MeshStandardMaterial({ color: 0x1b222a, metalness: 0.35, roughness: 0.6 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x0b0e12, roughness: 0.9 })
    const height = FLOOR - 0.3
    this.add(this.world, new THREE.BoxGeometry(LENGTH - 0.2, height, DEPTH - 0.2), panel, 0, height / 2, 0)
    for (const x of [-LENGTH / 2 + 0.1, -2, 2, LENGTH / 2 - 0.1]) {
      this.add(this.world, new THREE.BoxGeometry(0.14, height, 0.1), frame, x, height / 2, FRONT - 0.08)
    }
    // Vent slats on the right-hand bay.
    for (let i = 0; i < 7; i++) this.add(this.world, new THREE.BoxGeometry(3.2, 0.04, 0.05), frame, 3.95, 0.3 + i * 0.12, FRONT - 0.07)
    // Nameplate.
    this.add(this.world, new THREE.PlaneGeometry(3.3, 0.5), this.label('WT-01  LOW-SPEED TUNNEL', 3.3, 0.5, '#c3cbd4', '#10151b'), -3.95, 0.95, FRONT - 0.03)
    this.add(this.world, new THREE.PlaneGeometry(3.3, 0.22), this.label('TEST SECTION 2D SLICE', 3.3, 0.22, '#7a8591', '#10151b'), -3.95, 0.5, FRONT - 0.03)

    // Manometer board: a backing plate with one glass tube per pressure tap.
    const boardX = 0
    this.add(this.world, new THREE.BoxGeometry(3.6, TUBE_HEIGHT + 0.22, 0.04), dark, boardX, 0.14 + (TUBE_HEIGHT + 0.22) / 2, FRONT - 0.05)
    const glass = new THREE.MeshPhysicalMaterial({ color: 0xcfe6f2, roughness: 0.05, transparent: true, opacity: 0.25, depthWrite: false })
    const tubes = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.06, TUBE_HEIGHT, 10), glass, TAPS)
    for (let i = 0; i < TAPS; i++) {
      this.matrix.makeTranslation(this.tubeX(i), 0.25 + TUBE_HEIGHT / 2, FRONT + 0.02)
      tubes.setMatrixAt(i, this.matrix)
    }
    this.world.add(tubes)
    for (let i = 0; i <= 4; i++) {
      this.add(this.world, new THREE.BoxGeometry(3.4, 0.008, 0.01), new THREE.MeshBasicMaterial({ color: 0x3a4652 }), boardX, 0.25 + (i * TUBE_HEIGHT) / 4, FRONT - 0.025)
    }
    this.add(this.world, new THREE.BoxGeometry(3.6, 0.1, 0.16), frame, boardX, 0.2, FRONT + 0.02)
    this.add(this.world, new THREE.BoxGeometry(3.6, 0.06, 0.16), frame, boardX, 0.28 + TUBE_HEIGHT, FRONT + 0.02)
  }

  private tubeX(tap: number): number {
    return -1.5 + (tap * 3) / (TAPS - 1)
  }

  /** Operator's console, floor markings and room dressing. */
  private buildRoom(): void {
    const frame = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.6, roughness: 0.4 })
    const light = new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.75, roughness: 0.3 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x0b0e12, roughness: 0.9 })
    const stripe = new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.8 })

    // Hazard line along the working side, and a mat in front of the door.
    this.add(this.world, new THREE.BoxGeometry(LENGTH + 9, 0.02, 0.12), stripe, 0, 0.011, FRONT + 0.9)
    this.add(this.world, new THREE.BoxGeometry(5.4, 0.03, 1.3), new THREE.MeshStandardMaterial({ color: 0x11161b, roughness: 0.95 }), 1.7, 0.016, FRONT + 1.8)

    // Console desk: legs, top, keyboard and a stool. The monitor is added with the instruments.
    const deskX = DESK_X
    const deskZ = DESK_Z
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) this.add(this.world, new THREE.BoxGeometry(0.07, 0.95, 0.07), frame, deskX + sx * 0.95, 0.475, deskZ + sz * 0.38)
    }
    this.add(this.world, new THREE.BoxGeometry(2.1, 0.07, 0.95), light, deskX, 0.98, deskZ)
    this.add(this.world, new THREE.BoxGeometry(0.75, 0.03, 0.26), dark, deskX + 0.1, 1.03, deskZ + 0.2)
    this.add(this.world, new THREE.BoxGeometry(0.16, 0.03, 0.22), dark, deskX + 0.7, 1.03, deskZ + 0.2)
    this.add(this.world, new THREE.CylinderGeometry(0.28, 0.28, 0.08, 16), dark, deskX + 0.1, 0.62, deskZ + 1)
    this.add(this.world, new THREE.CylinderGeometry(0.04, 0.04, 0.6, 8), frame, deskX + 0.1, 0.3, deskZ + 1)
    this.add(this.world, new THREE.CylinderGeometry(0.24, 0.24, 0.03, 12), frame, deskX + 0.1, 0.015, deskZ + 1)
    // Signal cable from the console to the cabinet.
    const cable = new THREE.CatmullRomCurve3([
      new THREE.Vector3(deskX + 0.9, 0.9, deskZ - 0.4),
      new THREE.Vector3(deskX + 1.2, 0.08, deskZ - 0.7),
      new THREE.Vector3(-5.2, 0.05, FRONT + 0.7),
      new THREE.Vector3(-5.2, 0.3, FRONT - 0.1),
    ])
    this.add(this.world, new THREE.TubeGeometry(cable, 24, 0.03, 6), dark, 0, 0, 0)

    // Seeded dressing: spare models on a rack, and an extinguisher.
    const rackX = 6.2
    const rackZ = FRONT + 2.9
    for (const sx of [-1, 1]) this.add(this.world, new THREE.BoxGeometry(0.07, 1.5, 0.5), frame, rackX + sx * 0.85, 0.75, rackZ)
    for (const y of [0.5, 1.1]) this.add(this.world, new THREE.BoxGeometry(1.7, 0.05, 0.5), light, rackX, y, rackZ)
    const spare = new THREE.MeshStandardMaterial({ color: 0xc9d1da, metalness: 0.6, roughness: 0.35 })
    const kinds: ShapeKind[] = ['cylinder', 'wedge', 'airfoil', 'plate']
    for (let i = 0; i < 3; i++) {
      const kind = kinds[(this.rng.int(0, 3) + i) % kinds.length]
      const outline = new THREE.Shape(shapeOutline(kind).map(([x, y]) => new THREE.Vector2(x * 0.5, y * 0.5)))
      const geometry = new THREE.ExtrudeGeometry(outline, { depth: 0.4, bevelEnabled: false, curveSegments: 12 })
      this.add(this.world, geometry, spare, rackX - 0.5 + i * 0.5, i === 1 ? 1.3 : 0.7, rackZ - 0.2)
    }
    const extinguisherX = this.rng.range(8.6, 9.6)
    this.add(this.world, new THREE.CylinderGeometry(0.16, 0.16, 0.8, 12), new THREE.MeshStandardMaterial({ color: palette.red, metalness: 0.3, roughness: 0.45 }), extinguisherX, 0.4, FRONT + 3.4)
    this.add(this.world, new THREE.CylinderGeometry(0.05, 0.08, 0.16, 8), dark, extinguisherX, 0.88, FRONT + 3.4)
  }

  private buildFan(): void {
    const fanX = LENGTH / 2 + 2.6 + 0.95
    this.fan = new THREE.Group()
    this.fan.position.set(fanX, MID, 0)
    const metal = new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.7, roughness: 0.3 })
    // Six pitched blades, each a hub-to-tip slab offset from the axis.
    const blade = new THREE.BoxGeometry(0.07, 2.5, 0.62)
    blade.translate(0, 1.6, 0)
    for (let i = 0; i < 6; i++) {
      const holder = new THREE.Group()
      holder.rotation.x = (i * Math.PI) / 3
      const mesh = this.add(holder, blade, metal, 0, 0, 0)
      mesh.rotation.y = 0.5
      this.fan.add(holder)
    }
    const hub = new THREE.CylinderGeometry(0.5, 0.5, 0.5, 18)
    hub.rotateZ(Math.PI / 2)
    this.add(this.fan, hub, new THREE.MeshStandardMaterial({ color: palette.cyan, roughness: 0.5 }), 0, 0, 0)
    const spinner = new THREE.ConeGeometry(0.5, 0.7, 18)
    spinner.rotateZ(-Math.PI / 2)
    this.add(this.fan, spinner, metal, 0.6, 0, 0)
    this.world.add(this.fan)
  }

  /** Live readouts: the console monitor, the wind speed sign, manometer liquid and the angle pointer. */
  private buildInstruments(): void {
    const frame = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.6, roughness: 0.4 })
    const canvasTexture = (width: number, height: number) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const texture = new THREE.CanvasTexture(canvas)
      texture.colorSpace = THREE.SRGBColorSpace
      return { texture, context: canvas.getContext('2d')! }
    }

    // Console monitor: lift and drag over time.
    this.graph = canvasTexture(384, 224)
    const deskX = DESK_X
    const deskZ = DESK_Z
    const monitor = new THREE.Group()
    monitor.position.set(deskX - 0.3, 1.55, deskZ - 0.25)
    monitor.rotation.y = 0.18
    this.add(monitor, new THREE.BoxGeometry(1.5, 0.92, 0.06), frame, 0, 0, -0.04)
    this.add(monitor, new THREE.PlaneGeometry(1.4, 0.82), new THREE.MeshBasicMaterial({ map: this.graph.texture, toneMapped: false }), 0, 0, 0)
    this.add(monitor, new THREE.BoxGeometry(0.1, 0.3, 0.08), frame, 0, -0.55, -0.06)
    this.add(monitor, new THREE.BoxGeometry(0.5, 0.03, 0.3), frame, 0, -0.7, 0)
    this.world.add(monitor)

    // Wind speed sign on the roof of the test section.
    this.sign = { ...canvasTexture(256, 80), shown: '' }
    this.add(this.world, new THREE.BoxGeometry(2.3, 0.78, 0.2), frame, -3.6, TOP + 0.56, FRONT - 0.2)
    this.add(this.world, new THREE.PlaneGeometry(2.1, 0.62), new THREE.MeshBasicMaterial({ map: this.sign.texture, toneMapped: false }), -3.6, TOP + 0.56, FRONT - 0.09)

    // Manometer liquid, one column per tap, read just above the model.
    const { grid } = this
    this.tapCells = Array.from({ length: TAPS }, (_, i) => {
      const x = Math.round(grid.centerX + grid.chord * lerp(-0.7, 1.1, i / (TAPS - 1)))
      const y = Math.round(grid.centerY + grid.chord * 0.45)
      return Math.min(grid.height - 2, y) * grid.width + THREE.MathUtils.clamp(x, 2, grid.width - 2)
    })
    const column = new THREE.CylinderGeometry(0.042, 0.042, 1, 8)
    column.translate(0, 0.5, 0)
    this.liquid = new THREE.InstancedMesh(column, new THREE.MeshBasicMaterial({ color: 0xe0483c, toneMapped: false }), TAPS)
    this.liquid.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.world.add(this.liquid)

    // Pointer on the protractor that turns with the model.
    const [modelX] = this.gridToWorld(grid.centerX, 0)
    const needle = new THREE.BoxGeometry(3.9, 0.04, 0.02)
    this.pointerDisc = this.add(this.world, needle, new THREE.MeshBasicMaterial({ color: palette.amber, toneMapped: false }), modelX, MID, -FRONT + 0.1)

    this.drawGraph()
    this.drawSign()
  }

  private drawGraph(): void {
    if (!this.graph) return
    const { context: g, texture } = this.graph
    const w = g.canvas.width
    const h = g.canvas.height
    const top = 64
    const bottom = h - 12
    // The plot spans coefficients from -0.5 to 2.
    const y = (value: number) => bottom - ((THREE.MathUtils.clamp(value, -0.5, 2) + 0.5) / 2.5) * (bottom - top)
    g.fillStyle = '#070a0d'
    g.fillRect(0, 0, w, h)
    g.strokeStyle = '#1d252e'
    g.lineWidth = 1
    for (const value of [-0.5, 0, 0.5, 1, 1.5, 2]) {
      g.beginPath()
      g.moveTo(0, y(value))
      g.lineTo(w, y(value))
      g.stroke()
    }
    g.strokeStyle = '#3a4652'
    g.beginPath()
    g.moveTo(0, y(0))
    g.lineTo(w, y(0))
    g.stroke()
    const plot = (key: 'lift' | 'drag', color: string) => {
      g.strokeStyle = color
      g.lineWidth = 3
      g.beginPath()
      this.history.forEach((sample, i) => {
        const x = (i / (GRAPH_SAMPLES - 1)) * w
        if (i === 0) g.moveTo(x, y(sample[key]))
        else g.lineTo(x, y(sample[key]))
      })
      g.stroke()
    }
    plot('drag', '#ff5a4f')
    plot('lift', '#5fd38d')
    g.font = '600 26px "IBM Plex Mono", ui-monospace, monospace'
    g.fillStyle = '#5fd38d'
    g.fillText(`CL ${this.grid.lift.toFixed(2)}`, 12, 38)
    g.fillStyle = '#ff5a4f'
    g.fillText(`CD ${this.grid.drag.toFixed(2)}`, 200, 38)
    texture.needsUpdate = true
  }

  private drawSign(): void {
    if (!this.sign) return
    const text = `${this.num('wind').toFixed(0)} m/s`
    if (text === this.sign.shown) return
    this.sign.shown = text
    const { context: g, texture } = this.sign
    g.fillStyle = '#0a0705'
    g.fillRect(0, 0, g.canvas.width, g.canvas.height)
    g.fillStyle = '#ffb020'
    g.font = '600 52px "IBM Plex Mono", ui-monospace, monospace'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(text, g.canvas.width / 2, g.canvas.height / 2 + 3)
    texture.needsUpdate = true
  }

  private paintManometer(): void {
    for (let i = 0; i < TAPS; i++) {
      this.position.set(this.tubeX(i), 0.25, FRONT + 0.02)
      this.matrix.compose(this.position, this.quaternion, this.scale.set(1, this.tapLevels[i] * TUBE_HEIGHT, 1))
      this.liquid.setMatrixAt(i, this.matrix)
    }
    this.liquid.instanceMatrix.needsUpdate = true
  }

  /** The sheet the flow is drawn on: one texel per grid cell, repainted every frame. */
  private buildFlowPlane(): void {
    const { width, height } = this.grid
    this.pixels = new Uint8Array(width * height * 4)
    const texture = new THREE.DataTexture(this.pixels, width, height, THREE.RGBAFormat)
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.colorSpace = THREE.SRGBColorSpace
    texture.needsUpdate = true
    this.texture = texture
    const plane = this.add(
      this.world,
      new THREE.PlaneGeometry(LENGTH, HEIGHT),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
      0,
      MID,
      0,
    )
    plane.renderOrder = 2
  }

  /** Writes the chosen field into the texture. Smoke is always layered on top. */
  private paintFlow(): void {
    if (!this.texture) return
    const { grid, pixels } = this
    const view = this.params.view as View
    const wind = Math.max(this.num('wind'), 1e-6)
    // Pressure coefficient: pressure over the dynamic pressure of the free stream.
    const pressureScale = 1 / (STEP * 0.5 * wind * wind)
    const smokeWeight = view === 'smoke' ? 1 : 0.55
    const { smoke, centerU, centerV, pressure, curl, solid } = grid
    for (let i = 0; i < smoke.length; i++) {
      const o = i * 4
      if (solid[i]) {
        pixels[o + 3] = 0
        continue
      }
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      if (view === 'speed') {
        // Slow air blue, free-stream speed dark, fast air amber.
        const t = Math.hypot(centerU[i], centerV[i]) / wind
        if (t < 1) {
          r = lerp(30, 12, t)
          g = lerp(110, 22, t)
          b = lerp(235, 32, t)
        } else {
          const k = Math.min(1, t - 1)
          r = lerp(12, 255, k)
          g = lerp(22, 176, k)
          b = 32
        }
        a = 215
      } else if (view === 'pressure') {
        // High pressure red (where air piles up), low pressure blue (suction).
        const t = THREE.MathUtils.clamp(pressure[i] * pressureScale, -1, 1)
        r = t > 0 ? lerp(14, 255, t) : lerp(14, 40, -t)
        g = t > 0 ? lerp(20, 80, t) : lerp(20, 150, -t)
        b = t > 0 ? lerp(28, 70, t) : lerp(28, 255, -t)
        a = 215
      } else if (view === 'vorticity') {
        // Counter-clockwise spin cyan, clockwise orange.
        const t = THREE.MathUtils.clamp((curl[i] / wind) * 5, -1, 1)
        r = t > 0 ? lerp(12, 76, t) : lerp(12, 255, -t)
        g = t > 0 ? lerp(18, 201, t) : lerp(18, 138, -t)
        b = t > 0 ? lerp(26, 240, t) : lerp(26, 31, -t)
        a = 215
      }
      // Smoke: pale blue-white, brightening whatever is under it.
      const smokeAlpha = Math.min(1, smoke[i] * 1.15)
      pixels[o] = lerp(r, 226, smokeAlpha * smokeWeight)
      pixels[o + 1] = lerp(g, 240, smokeAlpha * smokeWeight)
      pixels[o + 2] = lerp(b, 255, smokeAlpha * smokeWeight)
      pixels[o + 3] = view === 'smoke' ? smokeAlpha * 235 : a
    }
    this.texture.needsUpdate = true
  }

  /** Tracer specks released at the inlet and carried through the measured velocity field. */
  private buildTracers(): void {
    const count = this.isPreview ? 90 : this.ctx.mobile ? 140 : 280
    const { width, height } = this.grid
    this.tracers = Array.from({ length: count }, () => ({
      x: this.fx.range(1, width - 2),
      y: this.fx.range(1, height - 1),
      age: this.fx.range(0, 6),
      life: this.fx.range(5, 9),
    }))
    this.tracerMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 0.022, 0.022),
      new THREE.MeshBasicMaterial({ color: 0xdff1ff, transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false }),
      count,
    )
    this.tracerMesh.frustumCulled = false
    this.tracerMesh.renderOrder = 3
    this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.world.add(this.tracerMesh)
  }

  private advectTracers(dt: number): void {
    const { grid } = this
    const { width, height, centerU, centerV, solid } = grid
    for (const tracer of this.tracers) {
      const cell = (tracer.y | 0) * width + (tracer.x | 0)
      tracer.x += centerU[cell] * dt
      tracer.y += centerV[cell] * dt
      tracer.age += dt
      const outside = tracer.x >= width - 1 || tracer.x < 1 || tracer.y < 0.5 || tracer.y >= height - 0.5
      if (outside || tracer.age > tracer.life || solid[(tracer.y | 0) * width + (tracer.x | 0)]) {
        tracer.x = 1 + this.fx.range(0, 1.5)
        tracer.y = this.fx.range(1, height - 1)
        tracer.age = 0
        tracer.life = this.fx.range(5, 9)
      }
    }
  }

  /** Each tracer is a short streak along the local flow, longer where the air is faster. */
  private paintTracers(): void {
    const visible = this.bool('tracers')
    this.tracerMesh.visible = visible
    if (!visible) return
    const { width, centerU, centerV } = this.grid
    const wind = Math.max(this.num('wind'), 1e-6)
    this.tracers.forEach((tracer, i) => {
      const cell = (tracer.y | 0) * width + (tracer.x | 0)
      const u = centerU[cell]
      const v = centerV[cell]
      const [x, y] = this.gridToWorld(tracer.x, tracer.y)
      this.position.set(x, y, 0.03)
      this.quaternion.setFromAxisAngle(this.axisZ, Math.atan2(v, u))
      this.scale.set(0.06 + Math.min(2, Math.hypot(u, v) / wind) * 0.2, 1, 1)
      this.matrix.compose(this.position, this.quaternion, this.scale)
      this.tracerMesh.setMatrixAt(i, this.matrix)
    })
    this.quaternion.identity()
    this.tracerMesh.instanceMatrix.needsUpdate = true
  }

  /** The test body: the solver's outline, extruded across the tunnel, with tufts taped along it. */
  private buildModel(): void {
    if (this.model) {
      this.world.remove(this.model)
      this.model.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose()
      })
      this.world.remove(this.tuftMesh)
      this.tuftMesh.geometry.dispose()
      ;(this.tuftMesh.material as THREE.Material).dispose()
    } else {
      this.modelMaterial = new THREE.MeshPhysicalMaterial({ color: 0xd9dde3, metalness: 0.7, roughness: 0.28, clearcoat: 0.6, clearcoatRoughness: 0.2 })
    }
    const chord = (this.grid.chord / this.grid.height) * HEIGHT
    const outline = shapeOutline(this.shape())
    const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x * chord, y * chord)))
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: SPAN, bevelEnabled: false, curveSegments: 24 })
    geometry.translate(0, 0, -SPAN / 2)
    this.model = new THREE.Group()
    this.model.add(new THREE.Mesh(geometry, this.modelMaterial))

    // Painted stripes round the section, a hub on the end face, and a chord line.
    const paint = new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.5 })
    for (const z of [-SPAN / 2 + 0.25, SPAN / 2 - 0.5]) {
      const band = new THREE.ExtrudeGeometry(new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x * chord * 1.004, y * chord * 1.03))), {
        depth: 0.12,
        bevelEnabled: false,
        curveSegments: 24,
      })
      band.translate(0, 0, z)
      this.model.add(new THREE.Mesh(band, paint))
    }
    const hub = new THREE.CylinderGeometry(0.16, 0.16, 0.08, 14)
    hub.rotateX(Math.PI / 2)
    this.add(this.model, hub, new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.6, roughness: 0.4 }), 0, 0, SPAN / 2 + 0.04)
    this.add(this.model, new THREE.BoxGeometry(chord * 0.94, 0.012, 0.012), new THREE.MeshBasicMaterial({ color: 0x12161a }), 0, 0, SPAN / 2 + 0.008)

    const [x, y] = this.gridToWorld(this.grid.centerX, this.grid.centerY)
    this.model.position.set(x, y, 0)
    this.world.add(this.model)
    this.enableShadows(this.model)

    // Tufts: one every few centimetres round the section.
    const samples = perimeterSamples(outline, 0.075)
    this.tufts = samples.map((sample) => ({ x: sample.x, y: sample.y, cell: 0, phase: this.fx.range(0, Math.PI * 2) }))
    const tuft = new THREE.BoxGeometry(TUFT_LENGTH, 0.022, 0.022)
    tuft.translate(TUFT_LENGTH / 2, 0, 0)
    this.tuftMesh = new THREE.InstancedMesh(tuft, new THREE.MeshBasicMaterial({ color: 0xff8a1f, toneMapped: false }), Math.max(samples.length, 1))
    this.tuftMesh.count = samples.length
    this.tuftMesh.frustumCulled = false
    this.tuftMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.tuftNormals = samples.map((sample) => [sample.nx, sample.ny])
    this.world.add(this.tuftMesh)
    this.poseModel()
  }

  /** Applies the angle of attack to the model, its protractor pointer and where each tuft reads the air. */
  private poseModel(): void {
    if (!this.model) return
    const angle = (-this.num('angle') * Math.PI) / 180
    this.model.rotation.z = angle
    this.pointerDisc.rotation.z = angle
    const { grid } = this
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    this.tufts.forEach((tuft, i) => {
      const [nx, ny] = this.tuftNormals[i]
      // Read the air a couple of cells off the surface, along the outward normal.
      const lx = tuft.x * grid.chord + nx * 2.2
      const ly = tuft.y * grid.chord + ny * 2.2
      const gx = Math.round(grid.centerX + lx * cos - ly * sin)
      const gy = Math.round(grid.centerY + lx * sin + ly * cos)
      tuft.cell = THREE.MathUtils.clamp(gy, 1, grid.height - 2) * grid.width + THREE.MathUtils.clamp(gx, 1, grid.width - 2)
    })
  }

  /** Tufts lie along the air next to the skin; in separated flow they flap and point upstream. */
  private paintTufts(): void {
    if (!this.model) return
    const { grid } = this
    const chord = (grid.chord / grid.height) * HEIGHT
    const angle = this.model.rotation.z
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const wind = Math.max(this.num('wind'), 1e-6)
    const flutter = 0.1 + this.num('turbulence') * 0.25
    this.tufts.forEach((tuft, i) => {
      const [nx, ny] = this.tuftNormals[i]
      const lx = tuft.x * chord + nx * 0.03
      const ly = tuft.y * chord + ny * 0.03
      const u = grid.centerU[tuft.cell]
      const v = grid.centerV[tuft.cell]
      const speed = Math.hypot(u, v) / wind
      // Slow, separated air lets a tuft flap; fast attached air holds it steady.
      const wobble = Math.sin(this.time * 22 + tuft.phase) * flutter * (1.4 - Math.min(1, speed))
      this.position.set(this.model!.position.x + lx * cos - ly * sin, this.model!.position.y + lx * sin + ly * cos, SPAN / 2 - 0.2)
      this.quaternion.setFromAxisAngle(this.axisZ, Math.atan2(v, u) + wobble)
      this.matrix.compose(this.position, this.quaternion, this.scale.set(0.45 + Math.min(1, speed) * 0.55, 1, 1))
      this.tuftMesh.setMatrixAt(i, this.matrix)
    })
    this.quaternion.identity()
    this.tuftMesh.instanceMatrix.needsUpdate = true
  }

  /** Lift and drag arrows, drawn in front of the model. Each is one unit long and scaled by its force. */
  private buildArrows(): void {
    const [x, y] = this.gridToWorld(this.grid.centerX, this.grid.centerY)
    const arrow = (color: number) => {
      const group = new THREE.Group()
      const material = new THREE.MeshBasicMaterial({ color, toneMapped: false, depthTest: false })
      const shaft = new THREE.CylinderGeometry(0.045, 0.045, 0.8, 8)
      shaft.translate(0, 0.4, 0)
      const head = new THREE.ConeGeometry(0.14, 0.2, 10)
      head.translate(0, 0.9, 0)
      for (const geometry of [shaft, head]) {
        const mesh = new THREE.Mesh(geometry, material)
        mesh.renderOrder = 4
        group.add(mesh)
      }
      group.position.set(x, y, SPAN / 2 + 0.14)
      this.world.add(group)
      return group
    }
    this.liftArrow = arrow(palette.green)
    this.dragArrow = arrow(palette.red)
    this.dragArrow.rotation.z = -Math.PI / 2
  }

  /** Grid cell under the pointer on the flow sheet, or null when the pointer is off it. */
  private cellAt(event: PointerEvent): { x: number; y: number } | null {
    const element = this.ctx.element
    if (!element) return null
    const rect = element.getBoundingClientRect()
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    if (!this.raycaster.ray.intersectPlane(this.slice, this.hit)) return null
    const u = this.hit.x / LENGTH + 0.5
    const v = (this.hit.y - this.world.position.y - FLOOR) / HEIGHT
    if (u < 0.03 || u > 0.99 || v < 0.02 || v > 0.98) return null
    return { x: u * this.grid.width, y: v * this.grid.height }
  }

  private onPointerDown = (event: PointerEvent): void => {
    // Alt, the middle button or the right button leave the gesture to the camera controls.
    if (event.altKey || event.button !== 0) return
    const cell = this.cellAt(event)
    if (!cell) return
    event.stopImmediatePropagation()
    event.preventDefault()
    this.drag = { pointerId: event.pointerId, x: cell.x, y: cell.y }
    this.ctx.element?.setPointerCapture(event.pointerId)
    this.grid.stir(cell.x, cell.y, 0, 0)
  }

  private onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag
    if (!drag || drag.pointerId !== event.pointerId) return
    event.stopImmediatePropagation()
    const cell = this.cellAt(event)
    if (!cell) return
    // The air is pushed along the direction of the drag.
    const push = 2.2
    this.grid.stir(cell.x, cell.y, (cell.x - drag.x) * push, (cell.y - drag.y) * push)
    drag.x = cell.x
    drag.y = cell.y
  }

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return
    event.stopImmediatePropagation()
    this.drag = null
  }
}
