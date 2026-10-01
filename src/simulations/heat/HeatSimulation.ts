import * as THREE from 'three'
import { makeIsoCamera } from '../../three/cameras'
import { disposeObject } from '../../three/dispose'
import { palette } from '../../three/palette'
import { makePlinth } from '../../three/plinth'
import { BaseSimulation } from '../core/BaseSimulation'
import type { ParamValue, StatValue } from '../core/Simulation'
import { HeatGrid } from './HeatGrid'
import { heatFragmentShader, heatVertexShader } from './HeatShader'

const PLANE = 12
const SURFACE_Y = 0.52
const HEIGHT = 2.1
const MAX_ITERATIONS = 12
const AMBIENT_C = 20
const RANGE_C = 980

/** A heat source that drifts along a seeded Lissajous path. */
interface Emitter {
  frequencyX: number
  frequencyY: number
  phaseX: number
  phaseY: number
  strength: number
}

function toCelsius(value: number): number {
  return AMBIENT_C + value * RANGE_C
}

export default class HeatSimulation extends BaseSimulation {
  private grid = new HeatGrid(8)
  private emitters: Emitter[] = []
  private surface: THREE.Group | null = null
  private texture: THREE.DataTexture | null = null
  private pixels = new Uint16Array(0)
  private cursor!: THREE.Mesh
  private iterationDebt = 0

  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private hit = new THREE.Vector3()
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -SURFACE_Y)
  private stroke: { mode: 'paint' | 'erase'; x: number; y: number; pointerId: number } | null = null

  constructor() {
    super(makeIsoCamera(new THREE.Vector3(1, 0.95, 1)))
    this.params = {
      heatSource: 800,
      conductivity: 0.6,
      cooling: 0.25,
      speed: 1,
      resolution: '128',
      tool: 'paint',
      wander: true,
    }
  }

  protected build(): void {
    this.iterationDebt = 0
    this.stroke = null
    const size = this.resolution()
    this.grid = new HeatGrid(size)

    // Seeded starting conditions: a few fixed sources and some drifting emitters.
    const sources = this.rng.int(2, 4)
    for (let i = 0; i < sources; i++) {
      this.grid.paint(
        this.rng.range(0.15, 0.85) * size,
        this.rng.range(0.15, 0.85) * size,
        Math.max(1.2, size / 30),
        this.rng.range(0.55, 1),
      )
    }
    this.emitters = Array.from({ length: this.rng.int(2, 3) }, () => ({
      frequencyX: this.rng.range(0.11, 0.3),
      frequencyY: this.rng.range(0.11, 0.3),
      phaseX: this.rng.range(0, Math.PI * 2),
      phaseY: this.rng.range(0, Math.PI * 2),
      strength: this.rng.range(0.7, 1),
    }))

    this.world.add(makePlinth(PLANE + 3.2, PLANE + 3.2))
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(PLANE + 0.7, SURFACE_Y - 0.02, PLANE + 0.7),
      new THREE.MeshStandardMaterial({ color: 0x0d1014, roughness: 0.8, metalness: 0.2 }),
    )
    base.position.y = (SURFACE_Y - 0.02) / 2
    this.world.add(base)
    const frameMaterial = new THREE.MeshStandardMaterial({ color: palette.steel, metalness: 0.6, roughness: 0.4 })
    for (const [x, z, w, d] of [
      [0, PLANE / 2 + 0.22, PLANE + 0.7, 0.26],
      [0, -PLANE / 2 - 0.22, PLANE + 0.7, 0.26],
      [PLANE / 2 + 0.22, 0, 0.26, PLANE + 0.18],
      [-PLANE / 2 - 0.22, 0, 0.26, PLANE + 0.18],
    ]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), frameMaterial)
      bar.position.set(x, SURFACE_Y - 0.02, z)
      this.world.add(bar)
    }
    this.enableShadows(this.world)

    this.cursor = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1, 40),
      new THREE.MeshBasicMaterial({ color: palette.white, transparent: true, opacity: 0.8, depthTest: false }),
    )
    this.cursor.rotation.x = -Math.PI / 2
    this.cursor.visible = false
    this.cursor.renderOrder = 2
    this.world.add(this.cursor)

    this.buildSurface()
    this.lighting.setShadowExtent(12)
    this.setView((PLANE + 3.2) * (this.isPreview ? 0.74 : 0.86), (PLANE + 3.2) * 0.5 + (this.isPreview ? 0.3 : 2.2))

    const element = this.ctx.element
    if (element && !this.isPreview) {
      // Capture phase: these run before the camera controls and can claim the gesture.
      element.addEventListener('pointerdown', this.onPointerDown, true)
      element.addEventListener('pointermove', this.onPointerMove, true)
      element.addEventListener('pointerup', this.onPointerUp, true)
      element.addEventListener('pointercancel', this.onPointerUp, true)
      element.addEventListener('pointerleave', this.onPointerLeave)
      element.addEventListener('contextmenu', this.onContextMenu)
    }
  }

  protected teardown(): void {
    this.surface = null
    this.texture = null
    const element = this.ctx?.element
    if (!element) return
    element.removeEventListener('pointerdown', this.onPointerDown, true)
    element.removeEventListener('pointermove', this.onPointerMove, true)
    element.removeEventListener('pointerup', this.onPointerUp, true)
    element.removeEventListener('pointercancel', this.onPointerUp, true)
    element.removeEventListener('pointerleave', this.onPointerLeave)
    element.removeEventListener('contextmenu', this.onContextMenu)
  }

  protected update(dt: number): void {
    const { grid } = this
    const size = grid.size
    const speed = this.num('speed')

    if (this.bool('wander')) {
      const t = this.time
      for (const emitter of this.emitters) {
        const x = (0.5 + 0.38 * Math.sin(t * emitter.frequencyX * speed + emitter.phaseX)) * size
        const y = (0.5 + 0.38 * Math.sin(t * emitter.frequencyY * speed + emitter.phaseY)) * size
        grid.inject(x, y, Math.max(1.5, size / 22), emitter.strength * this.sourceStrength())
      }
    }

    // Finer grids need more iterations to spread heat the same world distance.
    this.iterationDebt += speed * Math.max(1, size / 64) * dt * 60
    const alpha = 0.24 * this.num('conductivity')
    const cooling = this.num('cooling') * 0.004
    let iterations = 0
    while (this.iterationDebt >= 1 && iterations < MAX_ITERATIONS) {
      grid.step(alpha, cooling)
      this.iterationDebt -= 1
      iterations++
    }
    this.iterationDebt = Math.min(this.iterationDebt, 1)
  }

  render(): void {
    if (!this.texture) return
    const source = this.grid.temperature
    const pixels = this.pixels
    for (let i = 0; i < source.length; i++) pixels[i] = THREE.DataUtils.toHalfFloat(source[i])
    this.texture.needsUpdate = true
  }

  protected onParam(key: string, _value: ParamValue): void {
    if (key !== 'resolution') return
    const size = this.resolution()
    if (size === this.grid.size) return
    // Keep the existing field; only its sampling changes.
    this.grid = this.grid.resample(size)
    this.buildSurface()
  }

  getStats(): Record<string, StatValue> {
    const seconds = Math.floor(this.time)
    return {
      maxTemp: toCelsius(this.grid.max()).toFixed(0),
      avgTemp: toCelsius(this.grid.average()).toFixed(1),
      gridSize: `${this.grid.size} × ${this.grid.size}`,
      simTime: `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
    }
  }

  entityCount(): number {
    return this.grid.size * this.grid.size
  }

  private resolution(): number {
    const requested = Number(this.params.resolution)
    return this.ctx.mobile ? Math.min(requested, 128) : requested
  }

  private sourceStrength(): number {
    return (this.num('heatSource') - AMBIENT_C) / RANGE_C
  }

  /** (Re)creates the displaced surface and its temperature texture for the current grid size. */
  private buildSurface(): void {
    if (this.surface) {
      disposeObject(this.surface)
      this.world.remove(this.surface)
    }
    const size = this.grid.size
    this.pixels = new Uint16Array(size * size)
    const texture = new THREE.DataTexture(this.pixels, size, size, THREE.RedFormat, THREE.HalfFloatType)
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.needsUpdate = true
    this.texture = texture

    const segments = Math.min(size, this.isPreview || this.ctx.mobile ? 64 : 160)
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(PLANE, PLANE, segments, segments),
      new THREE.ShaderMaterial({
        uniforms: {
          uTemperature: { value: texture },
          uSize: { value: size },
          uHeight: { value: HEIGHT },
          uSlope: { value: (HEIGHT * size) / (2 * PLANE) },
        },
        vertexShader: heatVertexShader,
        fragmentShader: heatFragmentShader,
      }),
    )
    mesh.rotation.x = -Math.PI / 2
    mesh.position.y = SURFACE_Y
    mesh.frustumCulled = false
    this.surface = new THREE.Group()
    this.surface.add(mesh)
    this.world.add(this.surface)
  }

  /** Grid cell under the pointer, or null when the pointer is off the grid. */
  private cellAt(event: PointerEvent): { x: number; y: number } | null {
    const element = this.ctx.element
    if (!element) return null
    const rect = element.getBoundingClientRect()
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    if (!this.raycaster.ray.intersectPlane(this.plane, this.hit)) return null
    const u = this.hit.x / PLANE + 0.5
    const v = 0.5 - this.hit.z / PLANE
    if (u < 0 || u > 1 || v < 0 || v > 1) return null
    return { x: u * this.grid.size, y: v * this.grid.size }
  }

  private brushRadius(): number {
    return Math.max(1.3, this.grid.size / 26)
  }

  private apply(mode: 'paint' | 'erase', x: number, y: number): void {
    if (mode === 'paint') this.grid.paint(x, y, this.brushRadius(), this.sourceStrength())
    else this.grid.erase(x, y, this.brushRadius() * 1.4)
  }

  private onPointerDown = (event: PointerEvent): void => {
    // Camera tool or Alt hands the gesture to the camera controls.
    if (this.params.tool === 'camera' || event.altKey || event.button === 1) return
    const cell = this.cellAt(event)
    if (!cell) return
    event.stopImmediatePropagation()
    event.preventDefault()
    const mode = event.button === 2 || this.params.tool === 'erase' ? 'erase' : 'paint'
    this.stroke = { mode, x: cell.x, y: cell.y, pointerId: event.pointerId }
    this.ctx.element?.setPointerCapture(event.pointerId)
    this.apply(mode, cell.x, cell.y)
  }

  private onPointerMove = (event: PointerEvent): void => {
    const cell = this.cellAt(event)
    this.cursor.visible = cell !== null && this.params.tool !== 'camera' && event.pointerType === 'mouse'
    if (cell) {
      const scale = (this.brushRadius() / this.grid.size) * PLANE
      this.cursor.scale.setScalar(scale)
      this.cursor.position.set(this.hit.x, SURFACE_Y + 0.02, this.hit.z)
    }
    const stroke = this.stroke
    if (!stroke || stroke.pointerId !== event.pointerId) return
    event.stopImmediatePropagation()
    if (!cell) return
    // Fill the gap since the last event so fast drags leave a continuous line.
    const distance = Math.hypot(cell.x - stroke.x, cell.y - stroke.y)
    const steps = Math.max(1, Math.ceil(distance / (this.brushRadius() * 0.5)))
    for (let i = 1; i <= steps; i++) {
      this.apply(stroke.mode, stroke.x + ((cell.x - stroke.x) * i) / steps, stroke.y + ((cell.y - stroke.y) * i) / steps)
    }
    stroke.x = cell.x
    stroke.y = cell.y
  }

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.stroke || this.stroke.pointerId !== event.pointerId) return
    event.stopImmediatePropagation()
    this.stroke = null
  }

  private onPointerLeave = (): void => {
    this.cursor.visible = false
  }

  private onContextMenu = (event: Event): void => {
    event.preventDefault()
  }
}
