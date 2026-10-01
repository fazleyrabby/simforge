import * as THREE from 'three'
import { makeIsoCamera } from '../../three/cameras'
import { BaseSimulation } from '../core/BaseSimulation'
import { Rng } from '../core/random'
import { STEP, type ParamValue, type StatValue } from '../core/Simulation'
import { OrbitalSystem, type Body, type OrbitalParams } from './OrbitalSystem'

const planetColors = [0x4cc9f0, 0xffb020, 0x5fd38d, 0xff5a4f, 0xc77dff, 0xe9edf2, 0xff8fab, 0x9bd1ff]
/** Softening length for the gravity-well sheet, so wells have rounded bottoms. */
const WELL_SOFTENING = 0.9
const WELL_DEPTH = 0.16
const WELL_Y = -0.7
const WELL_PINCH = 0.045

const starVertexShader = /* glsl */ `
  varying vec3 vPosition;
  varying vec3 vNormal;
  void main() {
    vPosition = position;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

/** Churning stellar surface: layered value noise drifting over the sphere, brighter toward the limb. */
const starFragmentShader = /* glsl */ `
  uniform float uTime;
  varying vec3 vPosition;
  varying vec3 vNormal;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  void main() {
    vec3 p = vPosition * 2.4;
    float n = noise(p + vec3(uTime * 0.25, 0.0, uTime * 0.18)) * 0.55
            + noise(p * 2.3 - vec3(0.0, uTime * 0.4, 0.0)) * 0.3
            + noise(p * 5.1 + vec3(uTime * 0.7)) * 0.15;
    vec3 color = mix(vec3(1.0, 0.38, 0.05), vec3(1.0, 0.95, 0.72), smoothstep(0.3, 0.75, n));
    float limb = 1.0 - max(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)), 0.0);
    color += vec3(1.0, 0.6, 0.2) * pow(limb, 2.0) * 0.6;
    gl_FragColor = vec4(color * 1.5, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

/** Rendering-side counterpart of one body. */
interface BodyVisual {
  body: Body
  root: THREE.Group
  /** The part that rotates about the body's own axis. */
  spinner: THREE.Object3D
  spin: number
  line: THREE.Line
  positions: Float32Array
  colors: Float32Array
  color: THREE.Color
  trail: { x: number; y: number }[]
  /** Comets only: the tail, pointed away from the star each frame. */
  tail: THREE.Mesh | null
}

/** A massless test particle on a circular Keplerian orbit. */
interface Asteroid {
  radius: number
  angle: number
  height: number
  size: number
}

export default class OrbitalSimulation extends BaseSimulation {
  private system!: OrbitalSystem
  /** Randomness for appearance only; never feeds the physics. */
  private fx = new Rng(1)
  private visuals: BodyVisual[] = []
  private initialBodies = 0
  private starUniforms = { uTime: { value: 0 } }
  private corona: THREE.Sprite[] = []
  private trailMax = 200
  private sampleStep = 0
  private outer = 10

  private asteroids: Asteroid[] = []
  private belt: THREE.InstancedMesh | null = null
  private well: THREE.LineSegments | null = null
  private wellGrid = 0
  private wellExtent = 0
  private starfield: THREE.Group | null = null

  private matrix = new THREE.Matrix4()
  private position = new THREE.Vector3()
  private scale = new THREE.Vector3()
  private quaternion = new THREE.Quaternion()
  private euler = new THREE.Euler()

  constructor() {
    super(makeIsoCamera(new THREE.Vector3(0.28, 1, 0.42)))
    this.params = { speed: 1.5, gravity: 1, planets: 5, eccentricity: 0.2, trails: true, well: true }
  }

  protected build(): void {
    this.visuals = []
    this.corona = []
    this.sampleStep = 0
    this.trailMax = this.isPreview ? 90 : 260
    this.fx = new Rng(this.seed + 7)
    this.system = new OrbitalSystem(this.rng, this.num('planets'), this.readParams())
    this.initialBodies = this.system.bodies.length

    this.outer = this.system.bodies.reduce((max, body) => Math.max(max, body.orbitRadius), 6) + 2.5
    this.buildStarfield()
    this.buildWell()
    this.buildGuides()
    this.buildBelt()
    for (const body of this.system.bodies) this.visuals.push(this.makeVisual(body))

    this.focus.set(0, 0, 0)
    this.setView(this.outer * 1.15, this.outer * (this.isPreview ? 0.78 : 0.9))
  }

  protected teardown(): void {
    this.belt = null
    this.well = null
    this.starfield = null
  }

  protected update(dt: number): void {
    // Advance physics by dt·speed; the system picks substeps fine enough for its tightest orbit.
    const total = dt * this.num('speed')
    this.system.advance(total, STEP)

    // Reconcile any body added at runtime (a launched comet).
    while (this.visuals.length < this.system.bodies.length) {
      this.visuals.push(this.makeVisual(this.system.bodies[this.visuals.length]))
    }

    // Belt particles follow Kepler's circular rate, ω = √(GM / r³), so they answer to the Gravity control too.
    const gm = this.system.G * this.system.bodies[0].mass
    for (const asteroid of this.asteroids) asteroid.angle += Math.sqrt(gm / asteroid.radius ** 3) * total

    for (const visual of this.visuals) visual.spinner.rotation.y += visual.spin * total

    this.sampleStep++
    if (this.sampleStep % 2 === 0) {
      for (const visual of this.visuals) {
        if (visual.body.star) continue
        visual.trail.push({ x: visual.body.x, y: visual.body.y })
        if (visual.trail.length > this.trailMax) visual.trail.shift()
      }
    }
    if (this.starfield) this.starfield.rotation.y += dt * 0.004
  }

  render(alpha: number): void {
    const showTrails = this.bool('trails')
    const star = this.system.bodies[0]
    // Extrapolate along each body's velocity between fixed steps, for smooth motion above 60 Hz.
    const ahead = STEP * alpha * this.num('speed')

    for (const visual of this.visuals) {
      const { body } = visual
      visual.root.position.set(body.x + body.vx * ahead, 0, body.y + body.vy * ahead)

      if (visual.tail) {
        // A comet's tail streams away from the star and grows as it falls inward.
        const dx = body.x - star.x
        const dy = body.y - star.y
        const distance = Math.max(Math.hypot(dx, dy), 0.5)
        visual.tail.rotation.y = Math.atan2(dx, dy)
        visual.tail.scale.set(1, 1, THREE.MathUtils.clamp(14 / distance, 0.8, 5))
      }

      visual.line.visible = showTrails && !body.star && visual.trail.length > 1
      if (!visual.line.visible) continue
      // Trails fade toward their tail: older samples are drawn darker (additive, so darker = fainter).
      const points = visual.trail
      for (let i = 0; i < points.length; i++) {
        const fade = ((i + 1) / points.length) ** 2
        visual.positions[i * 3] = points[i].x
        visual.positions[i * 3 + 1] = 0
        visual.positions[i * 3 + 2] = points[i].y
        visual.colors[i * 3] = visual.color.r * fade
        visual.colors[i * 3 + 1] = visual.color.g * fade
        visual.colors[i * 3 + 2] = visual.color.b * fade
      }
      const geometry = visual.line.geometry
      geometry.setDrawRange(0, points.length)
      geometry.attributes.position.needsUpdate = true
      geometry.attributes.color.needsUpdate = true
    }

    this.starUniforms.uTime.value = this.time
    this.corona.forEach((sprite, i) => {
      const pulse = 1 + Math.sin(this.time * (0.9 + i * 0.5) + i) * 0.06
      sprite.scale.setScalar(star.radius * (i === 0 ? 5.2 : 9) * pulse)
    })

    this.paintBelt()
    this.paintWell()
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
    const fastest = planets.reduce((max, body) => Math.max(max, Math.hypot(body.vx, body.vy)), 0)
    return {
      bodies: system.bodies.length,
      period: `${period.toFixed(1)} s`,
      fastest: fastest.toFixed(2),
      energy: system.totalEnergy().toFixed(0),
      momentum: system.angularMomentum().toFixed(0),
      elapsed: `${system.time.toFixed(0)} s`,
    }
  }

  entityCount(): number {
    return this.system.bodies.length + this.asteroids.length
  }

  private readParams(): OrbitalParams {
    return { gravity: this.num('gravity'), eccentricity: this.num('eccentricity') }
  }

  private makeVisual(body: Body): BodyVisual {
    const root = new THREE.Group()
    root.position.set(body.x, 0, body.y)
    this.world.add(root)
    const comet = !body.star && body.id >= this.initialBodies
    const color = new THREE.Color(body.star ? 0xffffff : comet ? 0xcfeaff : planetColors[(body.id - 1) % planetColors.length])

    let spinner: THREE.Object3D
    let tail: THREE.Mesh | null = null
    let spin = 0
    if (body.star) {
      spinner = this.buildStar(root, body)
      spin = 0.05
    } else if (comet) {
      spinner = new THREE.Mesh(
        new THREE.IcosahedronGeometry(Math.max(body.radius, 0.16), 0),
        new THREE.MeshStandardMaterial({ color: 0xdfeefa, emissive: 0x9fdcff, emissiveIntensity: 0.6, roughness: 0.6, flatShading: true }),
      )
      root.add(spinner)
      spin = 2
      // Tail geometry points along +Z; render() turns it away from the star.
      const cone = new THREE.ConeGeometry(Math.max(body.radius, 0.16) * 1.1, 1.6, 12, 1, true)
      cone.rotateX(Math.PI / 2)
      cone.translate(0, 0, 0.8)
      tail = new THREE.Mesh(
        cone,
        new THREE.MeshBasicMaterial({
          color: 0x9fdcff,
          transparent: true,
          opacity: 0.28,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      )
      root.add(tail)
    } else {
      spinner = this.buildPlanet(root, body, color)
      spin = this.fx.range(0.6, 2.2) * (this.fx.chance(0.15) ? -1 : 1)
    }

    // One line per body holds its recent path, colored per vertex so it can fade.
    const positions = new Float32Array(this.trailMax * 3)
    const colors = new Float32Array(this.trailMax * 3)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geometry.setDrawRange(0, 0)
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    line.frustumCulled = false
    this.world.add(line)

    return { body, root, spinner, spin, line, positions, colors, color, trail: [], tail }
  }

  private buildStar(root: THREE.Group, body: Body): THREE.Object3D {
    const surface = new THREE.Mesh(
      new THREE.SphereGeometry(body.radius, 48, 32),
      new THREE.ShaderMaterial({ uniforms: this.starUniforms, vertexShader: starVertexShader, fragmentShader: starFragmentShader }),
    )
    root.add(surface)
    root.add(new THREE.PointLight(0xfff1dc, 60, 0, 1.3))

    // Corona: two additive glow sprites that pulse out of phase.
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 128
    const context = canvas.getContext('2d')!
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64)
    gradient.addColorStop(0, 'rgba(255, 214, 140, 1)')
    gradient.addColorStop(0.25, 'rgba(255, 160, 50, 0.55)')
    gradient.addColorStop(0.6, 'rgba(255, 110, 20, 0.12)')
    gradient.addColorStop(1, 'rgba(255, 90, 0, 0)')
    context.fillStyle = gradient
    context.fillRect(0, 0, 128, 128)
    const glow = new THREE.CanvasTexture(canvas)
    glow.colorSpace = THREE.SRGBColorSpace
    for (const opacity of [0.9, 0.35]) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: glow, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending }),
      )
      root.add(sprite)
      this.corona.push(sprite)
    }
    return surface
  }

  /** A planet with a procedural surface, an axial tilt, an atmosphere and sometimes rings. */
  private buildPlanet(root: THREE.Group, body: Body, color: THREE.Color): THREE.Object3D {
    const tilt = new THREE.Group()
    tilt.rotation.set(this.fx.range(-0.5, 0.5), 0, this.fx.range(-0.5, 0.5))
    root.add(tilt)

    // Bigger bodies are banded gas giants; smaller ones are cratered rock.
    const giant = body.radius > 0.42
    const surface = new THREE.Mesh(
      new THREE.SphereGeometry(body.radius, 28, 20),
      new THREE.MeshStandardMaterial({ map: this.planetTexture(color, giant), roughness: giant ? 0.7 : 0.95, metalness: 0.02 }),
    )
    tilt.add(surface)

    tilt.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(body.radius * 1.14, 24, 16),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: giant ? 0.2 : 0.12,
          side: THREE.BackSide,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      ),
    )

    if (giant && this.fx.chance(0.7)) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(body.radius * 1.45, body.radius * 2.3, 56),
        new THREE.MeshBasicMaterial({
          map: this.ringTexture(color),
          transparent: true,
          opacity: 0.75,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      )
      // Map the texture radially so its bands become concentric rings.
      const uv = ring.geometry.attributes.uv
      const p = ring.geometry.attributes.position
      for (let i = 0; i < uv.count; i++) {
        const r = Math.hypot(p.getX(i), p.getY(i))
        uv.setXY(i, (r - body.radius * 1.45) / (body.radius * 0.85), 0.5)
      }
      ring.rotation.x = -Math.PI / 2
      tilt.add(ring)
    }
    return surface
  }

  private planetTexture(color: THREE.Color, giant: boolean): THREE.CanvasTexture {
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 64
    const context = canvas.getContext('2d')!
    const shade = new THREE.Color()
    const style = (lightness: number) => `#${shade.copy(color).multiplyScalar(lightness).getHexString()}`
    context.fillStyle = style(0.85)
    context.fillRect(0, 0, 128, 64)
    if (giant) {
      // Latitude bands of varying width and brightness, plus one storm.
      let y = 0
      while (y < 64) {
        const height = this.fx.range(2, 9)
        context.fillStyle = style(this.fx.range(0.55, 1.25))
        context.fillRect(0, y, 128, height)
        y += height
      }
      context.fillStyle = style(1.5)
      context.beginPath()
      context.ellipse(this.fx.range(20, 108), this.fx.range(20, 44), 9, 4, 0, 0, Math.PI * 2)
      context.fill()
    } else {
      // Blotchy terrain and craters.
      for (let i = 0; i < 46; i++) {
        context.fillStyle = style(this.fx.range(0.45, 1.3))
        context.beginPath()
        context.ellipse(this.fx.range(0, 128), this.fx.range(0, 64), this.fx.range(2, 12), this.fx.range(1.5, 7), this.fx.range(0, 3), 0, Math.PI * 2)
        context.fill()
      }
      context.fillStyle = 'rgba(255,255,255,0.5)'
      context.fillRect(0, 0, 128, this.fx.range(0, 5))
      context.fillRect(0, 64 - this.fx.range(0, 5), 128, 5)
    }
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.wrapS = THREE.RepeatWrapping
    return texture
  }

  private ringTexture(color: THREE.Color): THREE.CanvasTexture {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 4
    const context = canvas.getContext('2d')!
    const shade = new THREE.Color()
    for (let x = 0; x < 64; x++) {
      const gap = this.fx.chance(0.12)
      shade.copy(color).lerp(new THREE.Color(0xffffff), 0.45).multiplyScalar(this.fx.range(0.6, 1.1))
      context.fillStyle = gap ? 'rgba(0,0,0,0)' : `rgba(${Math.round(shade.r * 255)},${Math.round(shade.g * 255)},${Math.round(shade.b * 255)},${this.fx.range(0.5, 1)})`
      context.clearRect(x, 0, 1, 4)
      context.fillRect(x, 0, 1, 4)
    }
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  }

  /** Faint circles at each planet's starting orbital radius, as a reference to see drift against. */
  private buildGuides(): void {
    const material = new THREE.LineDashedMaterial({ color: 0x33414f, dashSize: 0.35, gapSize: 0.3, transparent: true, opacity: 0.7 })
    for (const body of this.system.bodies) {
      if (body.star) continue
      const points: THREE.Vector3[] = []
      for (let i = 0; i <= 96; i++) {
        const angle = (i / 96) * Math.PI * 2
        points.push(new THREE.Vector3(Math.cos(angle) * body.orbitRadius, -0.02, Math.sin(angle) * body.orbitRadius))
      }
      const circle = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material)
      circle.computeLineDistances()
      this.world.add(circle)
    }
  }

  /** An asteroid belt in the widest gap between planet orbits. */
  private buildBelt(): void {
    const radii = this.system.bodies
      .filter((body) => !body.star)
      .map((body) => body.orbitRadius)
      .sort((a, b) => a - b)
    let inner = radii[radii.length - 1] + 0.9
    let outer = inner + 1.2
    let widest = 1.5
    for (let i = 1; i < radii.length; i++) {
      const gap = radii[i] - radii[i - 1]
      if (gap > widest) {
        widest = gap
        inner = radii[i - 1] + gap * 0.3
        outer = radii[i] - gap * 0.3
      }
    }
    this.outer = Math.max(this.outer, outer + 1.5)

    const count = this.isPreview || this.ctx.mobile ? 110 : 320
    this.asteroids = Array.from({ length: count }, () => ({
      radius: this.fx.range(inner, outer),
      angle: this.fx.range(0, Math.PI * 2),
      height: this.fx.range(-0.12, 0.12),
      size: this.fx.range(0.025, 0.075),
    }))
    this.belt = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ color: 0x8d8478, roughness: 1, flatShading: true }),
      count,
    )
    this.belt.frustumCulled = false
    this.belt.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.world.add(this.belt)
  }

  private paintBelt(): void {
    if (!this.belt) return
    this.asteroids.forEach((asteroid, i) => {
      this.position.set(Math.cos(asteroid.angle) * asteroid.radius, asteroid.height, Math.sin(asteroid.angle) * asteroid.radius)
      this.euler.set(asteroid.angle * 3, asteroid.angle * 5, 0)
      this.quaternion.setFromEuler(this.euler)
      this.scale.setScalar(asteroid.size)
      this.matrix.compose(this.position, this.quaternion, this.scale)
      this.belt!.setMatrixAt(i, this.matrix)
    })
    this.belt.instanceMatrix.needsUpdate = true
  }

  /**
   * A grid sheet under the system, sagging by the gravitational potential
   * −Σ G·m / r of every body. Wells travel with the planets and deepen with
   * the Gravity control.
   */
  private buildWell(): void {
    const n = this.isPreview || this.ctx.mobile ? 26 : 44
    this.wellGrid = n
    this.wellExtent = this.outer * 1.2
    const positions = new Float32Array((n + 1) * (n + 1) * 3)
    const indices: number[] = []
    for (let row = 0; row <= n; row++) {
      for (let col = 0; col <= n; col++) {
        const i = row * (n + 1) + col
        if (col < n) indices.push(i, i + 1)
        if (row < n) indices.push(i, i + n + 1)
      }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setIndex(indices)
    this.well = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: 0x2f6f8f, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    this.well.frustumCulled = false
    this.world.add(this.well)
  }

  private paintWell(): void {
    const well = this.well
    if (!well) return
    well.visible = this.bool('well')
    if (!well.visible) return
    const n = this.wellGrid
    const extent = this.wellExtent
    const { bodies, G } = this.system
    const attribute = well.geometry.attributes.position as THREE.BufferAttribute
    const array = attribute.array as Float32Array
    const softening = WELL_SOFTENING * WELL_SOFTENING
    for (let row = 0; row <= n; row++) {
      const z = (row / n - 0.5) * 2 * extent
      for (let col = 0; col <= n; col++) {
        const x = (col / n - 0.5) * 2 * extent
        let potential = 0
        let pullX = 0
        let pullZ = 0
        for (const body of bodies) {
          const dx = x - body.x
          const dz = z - body.y
          // Planet masses are tiny next to the star's; a root keeps their wells visible.
          const weight = (G * Math.sqrt(body.mass)) / (dx * dx + dz * dz + softening)
          potential += weight * Math.sqrt(dx * dx + dz * dz + softening)
          // Grid lines are also drawn in toward each mass, so wells read from directly above.
          pullX += dx * weight
          pullZ += dz * weight
        }
        const i = (row * (n + 1) + col) * 3
        array[i] = x - pullX * WELL_PINCH
        array[i + 1] = WELL_Y - potential * WELL_DEPTH
        array[i + 2] = z - pullZ * WELL_PINCH
      }
    }
    attribute.needsUpdate = true
  }

  /** Seeded background stars in two layers; the whole field drifts slowly. */
  private buildStarfield(): void {
    this.starfield = new THREE.Group()
    this.world.add(this.starfield)
    const layers = [
      { count: this.isPreview ? 260 : 700, size: 0.16, color: 0x8ea3ba, opacity: 0.7 },
      { count: this.isPreview ? 40 : 110, size: 0.34, color: 0xdfe9ff, opacity: 0.95 },
      { count: this.isPreview ? 16 : 40, size: 0.3, color: 0xffc98a, opacity: 0.9 },
    ]
    for (const layer of layers) {
      const positions = new Float32Array(layer.count * 3)
      for (let i = 0; i < layer.count; i++) {
        const theta = this.fx.range(0, Math.PI * 2)
        const phi = Math.acos(this.fx.range(-1, 1))
        const r = this.fx.range(45, 70)
        positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
        positions[i * 3 + 1] = r * Math.cos(phi)
        positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      const stars = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({ color: layer.color, size: layer.size, sizeAttenuation: true, transparent: true, opacity: layer.opacity }),
      )
      stars.frustumCulled = false
      this.starfield.add(stars)
    }
  }
}
