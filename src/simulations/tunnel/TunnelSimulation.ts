import * as THREE from 'three'
import { makeIsoCamera } from '../../three/cameras'
import { mergeStaticMeshes } from '../../three/merge'
import { palette } from '../../three/palette'
import { makePlinth } from '../../three/plinth'
import { BaseSimulation } from '../core/BaseSimulation'
import type { ParamValue, StatValue } from '../core/Simulation'
import { FluidGrid, shapeOutline, type ShapeKind } from './FluidGrid'

/** The test section: the slice of air being simulated, standing upright along the tunnel. */
const LENGTH = 12
const HEIGHT = 6
const DEPTH = 3.2
const FLOOR = 1.6
const SPAN = 2.6
const STALL_ANGLE = 15

type View = 'smoke' | 'speed' | 'pressure' | 'vorticity'

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export default class TunnelSimulation extends BaseSimulation {
  private grid!: FluidGrid
  private pixels = new Uint8Array(0)
  private texture: THREE.DataTexture | null = null
  private model: THREE.Group | null = null
  private modelMaterial!: THREE.MeshPhysicalMaterial
  private fan!: THREE.Group
  private liftArrow!: THREE.Group
  private dragArrow!: THREE.Group
  private stalled = false

  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private hit = new THREE.Vector3()
  private slice = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
  private drag: { pointerId: number; x: number; y: number } | null = null

  constructor() {
    super(makeIsoCamera(new THREE.Vector3(0.5, 0.42, 1)))
    this.params = { shape: 'airfoil', angle: 12, wind: 22, turbulence: 0.35, view: 'smoke' }
  }

  protected build(): void {
    // Coarser air on previews and low-spec devices: the solver is the cost here.
    const [width, height, sweeps] = this.isPreview ? [64, 32, 24] : this.ctx.mobile ? [72, 36, 30] : [96, 48, 40]
    this.grid = new FluidGrid(width, height, this.rng, this.readParams(), sweeps)
    this.grid.setBody(this.shape(), this.num('angle'))
    this.stalled = false
    this.drag = null
    this.world.position.y = -(FLOOR + HEIGHT / 2)

    this.world.add(makePlinth(LENGTH + 11, DEPTH + 5))
    this.buildTunnel()
    mergeStaticMeshes(this.world)
    this.buildFan()
    this.buildFlowPlane()
    this.buildArrows()
    this.buildModel()

    this.enableShadows(this.world)
    this.lighting.setShadowExtent(14)
    this.setView(LENGTH * 0.5 + (this.isPreview ? 3.4 : 5.6), HEIGHT * 0.5 + (this.isPreview ? 1.7 : 3))

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
    const element = this.ctx?.element
    if (!element) return
    element.removeEventListener('pointerdown', this.onPointerDown, true)
    element.removeEventListener('pointermove', this.onPointerMove, true)
    element.removeEventListener('pointerup', this.onPointerUp, true)
    element.removeEventListener('pointercancel', this.onPointerUp, true)
  }

  protected update(dt: number): void {
    this.grid.step(dt)
    this.fan.rotation.x += (2 + this.num('wind') * 0.9) * dt
  }

  render(_alpha: number): void {
    this.paintFlow()
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
      else if (this.model) this.model.rotation.z = (-this.num('angle') * Math.PI) / 180
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
    return this.grid.width * this.grid.height
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

  /** Test section, inlet contraction with smoke rake, diffuser, stands and the force balance. */
  private buildTunnel(): void {
    const frame = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.6, roughness: 0.4 })
    const shell = new THREE.MeshStandardMaterial({ color: 0x39505e, metalness: 0.4, roughness: 0.5, side: THREE.DoubleSide })
    const dark = new THREE.MeshStandardMaterial({ color: 0x0b0e12, roughness: 0.9 })
    const accent = new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.6 })
    const top = FLOOR + HEIGHT
    const mid = FLOOR + HEIGHT / 2

    // Floor and ceiling of the test section, and a dark back wall for the smoke to show against.
    this.add(this.world, new THREE.BoxGeometry(LENGTH, 0.3, DEPTH), frame, 0, FLOOR - 0.15, 0)
    this.add(this.world, new THREE.BoxGeometry(LENGTH, 0.16, DEPTH), frame, 0, top + 0.08, 0)
    this.add(this.world, new THREE.BoxGeometry(LENGTH, HEIGHT, 0.08), dark, 0, mid, -DEPTH / 2)
    // Reference grid lines on the back wall.
    const gridLine = new THREE.MeshBasicMaterial({ color: 0x1c2630 })
    for (let i = 1; i < 6; i++) this.add(this.world, new THREE.BoxGeometry(LENGTH, 0.02, 0.02), gridLine, 0, FLOOR + i, -DEPTH / 2 + 0.06)
    for (let i = 1; i < 12; i++) this.add(this.world, new THREE.BoxGeometry(0.02, HEIGHT, 0.02), gridLine, -LENGTH / 2 + i, mid, -DEPTH / 2 + 0.06)
    // Frame posts and the front window.
    for (const x of [-LENGTH / 2, 0, LENGTH / 2]) {
      for (const z of [-DEPTH / 2, DEPTH / 2]) this.add(this.world, new THREE.BoxGeometry(0.16, HEIGHT + 0.46, 0.16), frame, x, mid, z)
    }
    this.add(
      this.world,
      new THREE.BoxGeometry(LENGTH, HEIGHT, 0.04),
      new THREE.MeshPhysicalMaterial({ color: 0xbfe0f0, roughness: 0.05, transparent: true, opacity: 0.07, depthWrite: false }),
      0,
      mid,
      DEPTH / 2,
    )

    // Inlet: a contraction that speeds the air up into the test section.
    const contraction = new THREE.CylinderGeometry(HEIGHT * 0.72, HEIGHT * 1.15, 3.4, 4, 1, true)
    contraction.rotateY(Math.PI / 4)
    contraction.rotateZ(-Math.PI / 2)
    contraction.scale(1, 1, DEPTH / HEIGHT)
    this.add(this.world, contraction, shell, -LENGTH / 2 - 1.7, mid, 0)
    // Honeycomb screen that straightens the incoming air.
    const screen = new THREE.MeshBasicMaterial({ color: 0x2a3a48 })
    for (let i = -4; i <= 4; i++) {
      this.add(this.world, new THREE.BoxGeometry(0.04, HEIGHT * 1.55, 0.04), screen, -LENGTH / 2 - 3.3, mid, (i / 4.5) * DEPTH * 0.78)
      this.add(this.world, new THREE.BoxGeometry(0.04, 0.04, DEPTH * 1.55), screen, -LENGTH / 2 - 3.3, mid + (i / 4.5) * HEIGHT * 0.78, 0)
    }
    // Smoke rake: one nozzle per smoke line.
    const spacing = Math.max(4, Math.round(this.grid.height / 12))
    this.add(this.world, new THREE.BoxGeometry(0.1, HEIGHT, 0.1), frame, -LENGTH / 2 + 0.12, mid, 0)
    for (let row = Math.round(spacing * 0.15); row < this.grid.height; row += spacing) {
      const [, y] = this.gridToWorld(0, row + 0.5)
      const nozzle = this.add(this.world, new THREE.CylinderGeometry(0.05, 0.08, 0.3, 8), accent, -LENGTH / 2 + 0.3, y, 0)
      nozzle.rotation.z = -Math.PI / 2
    }

    // Outlet: a diffuser widening into the fan housing.
    const diffuser = new THREE.CylinderGeometry(HEIGHT * 0.86, HEIGHT * 0.72, 2.4, 4, 1, true)
    diffuser.rotateY(Math.PI / 4)
    diffuser.rotateZ(-Math.PI / 2)
    diffuser.scale(1, 1, DEPTH / HEIGHT)
    this.add(this.world, diffuser, shell, LENGTH / 2 + 1.2, mid, 0)
    const housing = new THREE.CylinderGeometry(HEIGHT * 0.5, HEIGHT * 0.5, 1.4, 28, 1, true)
    housing.rotateZ(Math.PI / 2)
    this.add(this.world, housing, shell, LENGTH / 2 + 3.1, mid, 0)
    for (const radius of [1.1, 2.1]) {
      const guard = this.add(this.world, new THREE.TorusGeometry(radius, 0.03, 6, 32), frame, LENGTH / 2 + 3.82, mid, 0)
      guard.rotation.y = Math.PI / 2
    }

    // Stands under each section.
    for (const x of [-LENGTH / 2 - 2, -LENGTH / 2 + 1, LENGTH / 2 - 1, LENGTH / 2 + 3.1]) {
      for (const z of [-1, 1]) this.add(this.world, new THREE.BoxGeometry(0.2, FLOOR - 0.3, 0.2), frame, x, (FLOOR - 0.3) / 2, z * DEPTH * 0.42)
    }
    // Force balance under the model, with its mounting strut.
    const [modelX] = this.gridToWorld(this.grid.centerX, 0)
    this.add(this.world, new THREE.BoxGeometry(1.5, 0.9, 1.4), frame, modelX, 0.45, 0)
    this.add(this.world, new THREE.BoxGeometry(0.7, 0.3, 0.03), new THREE.MeshStandardMaterial({ color: 0x06140f, emissive: palette.green, emissiveIntensity: 1 }), modelX, 0.55, 0.71)
    this.add(this.world, new THREE.CylinderGeometry(0.07, 0.07, mid - 0.9, 10), frame, modelX, (mid + 0.9) / 2, -SPAN / 2 + 0.2)
  }

  private buildFan(): void {
    this.fan = new THREE.Group()
    this.fan.position.set(LENGTH / 2 + 3.3, FLOOR + HEIGHT / 2, 0)
    const blade = new THREE.BoxGeometry(0.08, HEIGHT * 0.94, 0.5)
    const metal = new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.7, roughness: 0.3 })
    for (let i = 0; i < 4; i++) {
      const mesh = this.add(this.fan, blade, metal, 0, 0, 0)
      mesh.rotation.x = (i * Math.PI) / 4
      mesh.rotation.y = 0.35
    }
    const hub = new THREE.CylinderGeometry(0.45, 0.45, 0.5, 16)
    hub.rotateZ(Math.PI / 2)
    this.add(this.fan, hub, new THREE.MeshStandardMaterial({ color: palette.cyan, roughness: 0.5 }), 0, 0, 0)
    this.world.add(this.fan)
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
      FLOOR + HEIGHT / 2,
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
    const pressureScale = 60 / (0.5 * wind * wind)
    const { smoke, centerU, centerV, pressure, curl, solid } = grid
    for (let i = 0; i < smoke.length; i++) {
      const o = i * 4
      if (solid[i]) {
        pixels[o + 3] = 0
        continue
      }
      const s = smoke[i]
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
          b = lerp(32, 32, k)
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
      const smokeAlpha = Math.min(1, s * 1.15)
      pixels[o] = lerp(r, 226, smokeAlpha * (view === 'smoke' ? 1 : 0.55))
      pixels[o + 1] = lerp(g, 240, smokeAlpha * (view === 'smoke' ? 1 : 0.55))
      pixels[o + 2] = lerp(b, 255, smokeAlpha * (view === 'smoke' ? 1 : 0.55))
      pixels[o + 3] = view === 'smoke' ? smokeAlpha * 235 : a
    }
    this.texture.needsUpdate = true
  }

  /** The test body: the solver's outline, extruded across the tunnel. */
  private buildModel(): void {
    if (this.model) {
      this.world.remove(this.model)
      this.model.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose()
      })
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
    const [x, y] = this.gridToWorld(this.grid.centerX, this.grid.centerY)
    this.model.position.set(x, y, 0)
    this.model.rotation.z = (-this.num('angle') * Math.PI) / 180
    this.world.add(this.model)
    this.enableShadows(this.model)
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
      group.position.set(x, y, SPAN / 2 + 0.1)
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
