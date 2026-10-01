import * as THREE from 'three'
import { makeIsoCamera } from '../../three/cameras'
import { palette } from '../../three/palette'
import { BaseSimulation } from '../core/BaseSimulation'
import { STEP, type ParamValue, type StatValue } from '../core/Simulation'
import { OrbitalSystem, type Body, type OrbitalParams } from './OrbitalSystem'

const planetColors = [0x4cc9f0, 0xffb020, 0x5fd38d, 0xff5a4f, 0xc77dff, 0xe9edf2, 0xff8fab, 0x9bd1ff]

/** Rendering-side counterpart of one body. */
interface BodyVisual {
  body: Body
  mesh: THREE.Mesh
  line: THREE.Line
  positions: Float32Array
  trail: { x: number; y: number }[]
}

export default class OrbitalSimulation extends BaseSimulation {
  private system!: OrbitalSystem
  private visuals: BodyVisual[] = []
  private starMaterial: THREE.MeshStandardMaterial | null = null
  private trailMax = 200
  private sampleStep = 0
  private outer = 10

  constructor() {
    super(makeIsoCamera(new THREE.Vector3(0.28, 1, 0.42)))
    this.params = { speed: 1.5, gravity: 1, planets: 5, eccentricity: 0.2, trails: true }
  }

  protected build(): void {
    this.visuals = []
    this.sampleStep = 0
    this.trailMax = this.isPreview ? 70 : 200
    this.system = new OrbitalSystem(this.rng, this.num('planets'), this.readParams())

    this.buildStarfield()
    for (const body of this.system.bodies) this.visuals.push(this.makeVisual(body))

    this.outer = this.system.bodies.reduce((max, body) => Math.max(max, body.orbitRadius), 6) + 2.5
    this.focus.set(0, 0, 0)
    this.setView(this.outer * 1.15, this.outer * (this.isPreview ? 0.78 : 0.9))
  }

  protected update(dt: number): void {
    // Advance physics by dt·speed, substepping so each Verlet step stays ≤ STEP.
    const total = dt * this.num('speed')
    const substeps = Math.max(1, Math.ceil(total / STEP))
    const h = total / substeps
    for (let i = 0; i < substeps; i++) this.system.step(h)

    // Reconcile any body added at runtime (a launched comet).
    while (this.visuals.length < this.system.bodies.length) {
      this.visuals.push(this.makeVisual(this.system.bodies[this.visuals.length]))
    }

    this.sampleStep++
    if (this.sampleStep % 2 === 0) {
      for (const visual of this.visuals) {
        if (visual.body.star) continue
        visual.trail.push({ x: visual.body.x, y: visual.body.y })
        if (visual.trail.length > this.trailMax) visual.trail.shift()
      }
    }
  }

  render(_alpha: number): void {
    const showTrails = this.bool('trails')
    for (const visual of this.visuals) {
      visual.mesh.position.set(visual.body.x, 0, visual.body.y)
      visual.line.visible = showTrails && !visual.body.star && visual.trail.length > 1
      if (!visual.line.visible) continue
      const points = visual.trail
      for (let i = 0; i < points.length; i++) {
        visual.positions[i * 3] = points[i].x
        visual.positions[i * 3 + 1] = 0
        visual.positions[i * 3 + 2] = points[i].y
      }
      const geometry = visual.line.geometry
      geometry.setDrawRange(0, points.length)
      geometry.attributes.position.needsUpdate = true
      geometry.computeBoundingSphere()
    }

    if (this.starMaterial) {
      // The star breathes very slightly so it never reads as a flat disc.
      this.starMaterial.emissiveIntensity = 1.9 + Math.sin(this.time * 1.3) * 0.15
    }
  }

  protected onParam(key: string, _value: ParamValue): void {
    if (key === 'planets' || key === 'eccentricity') {
      this.rebuild()
    } else {
      this.system.params = this.readParams()
    }
  }

  action(key: string): void {
    if (key !== 'comet') return
    this.system.addComet()
    this.events.emit({
      type: 'comet_launched',
      level: 'info',
      title: 'COMET INBOUND',
      message: 'A body falls in from the edge on a steep ellipse, tugging the planets as it passes.',
    })
  }

  getStats(): Record<string, StatValue> {
    const { system } = this
    const planets = system.bodies.filter((body) => !body.star)
    // Period of the innermost planet, from the circular relation T = 2π√(r³/GM).
    const inner = planets.reduce((min, body) => Math.min(min, body.orbitRadius), Infinity)
    const gm = system.G * system.bodies[0].mass
    const period = inner === Infinity ? 0 : 2 * Math.PI * Math.sqrt(inner ** 3 / gm)
    return {
      bodies: system.bodies.length,
      period: `${period.toFixed(1)} s`,
      energy: system.totalEnergy().toFixed(0),
      momentum: system.angularMomentum().toFixed(0),
      elapsed: `${system.time.toFixed(0)} s`,
    }
  }

  entityCount(): number {
    return this.system.bodies.length
  }

  private readParams(): OrbitalParams {
    return { gravity: this.num('gravity'), eccentricity: this.num('eccentricity') }
  }

  private makeVisual(body: Body): BodyVisual {
    const geometry = new THREE.SphereGeometry(body.radius, body.star ? 32 : 20, body.star ? 24 : 16)
    let material: THREE.MeshStandardMaterial
    if (body.star) {
      material = new THREE.MeshStandardMaterial({
        color: 0xfff0d0,
        emissive: new THREE.Color(palette.amber),
        emissiveIntensity: 2,
        roughness: 1,
      })
      this.starMaterial = material
    } else {
      material = new THREE.MeshStandardMaterial({
        color: planetColors[(body.id - 1) % planetColors.length],
        roughness: 0.85,
        metalness: 0.05,
      })
    }
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(body.x, 0, body.y)
    this.world.add(mesh)

    if (body.star) {
      const light = new THREE.PointLight(0xfff1dc, 60, 0, 1.3)
      mesh.add(light)
      // A soft corona around the star.
      const corona = new THREE.Mesh(
        new THREE.SphereGeometry(body.radius * 1.7, 24, 16),
        new THREE.MeshBasicMaterial({ color: palette.amber, transparent: true, opacity: 0.12, depthWrite: false }),
      )
      mesh.add(corona)
    }

    // One line per body holds its recent path.
    const positions = new Float32Array(this.trailMax * 3)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setDrawRange(0, 0)
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({
        color: body.star ? 0xffffff : planetColors[(body.id - 1) % planetColors.length],
        transparent: true,
        opacity: 0.5,
      }),
    )
    line.frustumCulled = false
    this.world.add(line)

    return { body, mesh, line, positions, trail: [] }
  }

  /** A seeded field of distant stars so the void is not empty. */
  private buildStarfield(): void {
    const count = this.isPreview ? 220 : 600
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      // Points on a large shell, kept away from the orbital plane centre.
      const theta = this.rng.range(0, Math.PI * 2)
      const phi = Math.acos(this.rng.range(-1, 1))
      const r = this.rng.range(45, 70)
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      positions[i * 3 + 1] = r * Math.cos(phi)
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const stars = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({ color: 0x9fb2c8, size: 0.22, sizeAttenuation: true, transparent: true, opacity: 0.8 }),
    )
    stars.frustumCulled = false
    this.world.add(stars)
  }
}
