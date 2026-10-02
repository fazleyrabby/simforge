import type { Rng } from '../core/random'

export type ShapeKind = 'airfoil' | 'cylinder' | 'plate' | 'wedge'

export interface TunnelParams {
  /** Inflow speed in cells per second. */
  wind: number
  /** Vorticity confinement strength, 0..1. Keeps eddies from being smeared away. */
  turbulence: number
}

const TAU = Math.PI * 2

/**
 * Outline of a test body in chord units: centered on the origin, leading edge
 * at -x. The solver rasterizes this polygon and the renderer extrudes the same
 * points, so the solid the air flows round is exactly the model on screen.
 */
export function shapeOutline(kind: ShapeKind): [number, number][] {
  const points: [number, number][] = []
  if (kind === 'airfoil') {
    // NACA 0015 thickness distribution, upper surface forward to aft then lower surface back.
    const thickness = 0.15
    const half = (x: number) => 5 * thickness * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x ** 2 + 0.2843 * x ** 3 - 0.1015 * x ** 4)
    const samples = 24
    for (let i = 0; i <= samples; i++) {
      const x = (1 - Math.cos((i / samples) * Math.PI)) / 2
      points.push([x - 0.5, half(x)])
    }
    for (let i = samples - 1; i >= 1; i--) {
      const x = (1 - Math.cos((i / samples) * Math.PI)) / 2
      points.push([x - 0.5, -half(x)])
    }
  } else if (kind === 'cylinder') {
    for (let i = 0; i < 36; i++) {
      const angle = (i / 36) * TAU
      points.push([-Math.cos(angle) * 0.32, Math.sin(angle) * 0.32])
    }
  } else if (kind === 'plate') {
    points.push([-0.5, 0.045], [0.5, 0.045], [0.5, -0.045], [-0.5, -0.045])
  } else {
    points.push([-0.5, 0], [0.5, 0.26], [0.5, -0.26])
  }
  return points
}

/**
 * Two-dimensional incompressible air flow past a solid body, independent of
 * rendering. Jos Stam's stable-fluids scheme on a staggered (MAC) grid:
 * horizontal speed lives on the vertical faces between cells and vertical
 * speed on the horizontal faces, so the projection step can make the flow
 * through every cell balance exactly. Velocity is carried along itself, then
 * projected so no air is created or destroyed, with walls and the body solid.
 * Smoke rides the flow to make it visible, and pressure on the body's surface
 * gives lift and drag.
 *
 * Axes: x downstream, y up. Speeds are in cells per second.
 */
export class FluidGrid {
  /** Horizontal speed on vertical faces: (width + 1) × height. */
  readonly u: Float32Array
  /** Vertical speed on horizontal faces: width × (height + 1). */
  readonly v: Float32Array
  /** Cell-centered velocity, smoke, pressure and spin, for drawing and measuring. */
  readonly centerU: Float32Array
  readonly centerV: Float32Array
  readonly smoke: Float32Array
  readonly pressure: Float32Array
  readonly curl: Float32Array
  readonly solid: Uint8Array
  /** Smoothed force coefficients on the body. */
  lift = 0
  drag = 0
  time = 0
  /** Chord of the body in cells, and where its center sits. */
  readonly chord: number
  readonly centerX: number
  readonly centerY: number

  private u0: Float32Array
  private v0: Float32Array
  private smoke0: Float32Array
  private burstTime = 0

  constructor(
    readonly width: number,
    readonly height: number,
    rng: Rng,
    public params: TunnelParams,
    /** Pressure solver sweeps per step. */
    private iterations = 40,
  ) {
    const size = width * height
    this.u = new Float32Array((width + 1) * height)
    this.v = new Float32Array(width * (height + 1))
    this.u0 = new Float32Array(this.u.length)
    this.v0 = new Float32Array(this.v.length)
    this.centerU = new Float32Array(size)
    this.centerV = new Float32Array(size)
    this.smoke = new Float32Array(size)
    this.smoke0 = new Float32Array(size)
    this.pressure = new Float32Array(size)
    this.curl = new Float32Array(size)
    this.solid = new Uint8Array(size)
    this.chord = height * 0.5
    this.centerX = width * 0.3
    this.centerY = height * 0.5
    // Start from uniform flow with a trace of seeded noise; perfectly symmetric
    // flow would never start shedding vortices.
    this.u.fill(params.wind)
    for (let i = 0; i < this.v.length; i++) this.v[i] = rng.range(-0.02, 0.02) * params.wind
    this.applyBoundaries()
    this.updateCenters()
  }

  /** Places a body in the flow, pitched nose-up by `angle` degrees. */
  setBody(kind: ShapeKind, angle: number): void {
    const { width, height, chord, centerX, centerY } = this
    const outline = shapeOutline(kind)
    const cos = Math.cos((angle * Math.PI) / 180)
    const sin = Math.sin((angle * Math.PI) / 180)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Into the body's own frame: a nose-up pitch lifts the leading edge (-x).
        const dx = (x + 0.5 - centerX) / chord
        const dy = (y + 0.5 - centerY) / chord
        const lx = dx * cos - dy * sin
        const ly = dx * sin + dy * cos
        let inside = false
        for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
          const [xi, yi] = outline[i]
          const [xj, yj] = outline[j]
          if (yi > ly !== yj > ly && lx < ((xj - xi) * (ly - yi)) / (yj - yi) + xi) inside = !inside
        }
        const index = y * width + x
        this.solid[index] = inside ? 1 : 0
        if (inside) this.smoke[index] = 0
      }
    }
    this.applyBoundaries()
    this.updateCenters()
  }

  /** Fill the whole inlet with smoke for a moment. */
  burst(): void {
    this.burstTime = 0.5
  }

  /** Push the air and add smoke around a point, as a pointer drag does. */
  stir(x: number, y: number, forceX: number, forceY: number, radius = 3): void {
    const { width, height } = this
    for (let j = Math.max(1, Math.floor(y - radius)); j <= Math.min(height - 2, Math.ceil(y + radius)); j++) {
      for (let i = Math.max(2, Math.floor(x - radius)); i <= Math.min(width - 2, Math.ceil(x + radius)); i++) {
        const falloff = 1 - Math.hypot(i + 0.5 - x, j + 0.5 - y) / radius
        const index = j * width + i
        if (falloff <= 0 || this.solid[index]) continue
        this.u[j * (width + 1) + i] += forceX * falloff
        this.v[j * width + i] += forceY * falloff
        this.smoke[index] = Math.min(1, this.smoke[index] + falloff)
      }
    }
    this.applyBoundaries()
  }

  step(dt: number): void {
    this.time += dt
    this.burstTime = Math.max(0, this.burstTime - dt)
    if (this.params.turbulence > 0) this.confineVorticity(dt)
    this.applyBoundaries()
    this.advectVelocity(dt)
    this.applyBoundaries()
    this.project()
    this.updateCenters()

    this.emitSmoke()
    this.advectSmoke(dt)
    this.measureForces(dt)
  }

  /** Largest net flow into or out of any open cell. Near zero when mass is conserved. */
  maxDivergence(): number {
    const { width, height, u, v, solid } = this
    let max = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (solid[y * width + x]) continue
        const face = y * (width + 1) + x
        max = Math.max(max, Math.abs(u[face + 1] - u[face] + v[(y + 1) * width + x] - v[y * width + x]))
      }
    }
    return max
  }

  /** Fastest air anywhere, as a multiple of the inflow speed. */
  peakSpeed(): number {
    let max = 0
    for (let i = 0; i < this.centerU.length; i++) max = Math.max(max, this.centerU[i] ** 2 + this.centerV[i] ** 2)
    return Math.sqrt(max) / Math.max(this.params.wind, 1e-6)
  }

  /** Inflow on the left, slip walls top and bottom, and no flow through any face of the body. */
  private applyBoundaries(): void {
    const { width, height, u, v, solid } = this
    const stride = width + 1
    for (let y = 0; y < height; y++) {
      u[y * stride] = this.params.wind
      for (let x = 0; x < width; x++) {
        if (!solid[y * width + x]) continue
        u[y * stride + x] = 0
        u[y * stride + x + 1] = 0
        v[y * width + x] = 0
        v[(y + 1) * width + x] = 0
      }
    }
    for (let x = 0; x < width; x++) {
      v[x] = 0
      v[height * width + x] = 0
    }
  }

  /** Horizontal speed at a point, by bilinear interpolation between faces. */
  private sampleU(field: Float32Array, px: number, py: number): number {
    const { width, height } = this
    const stride = width + 1
    const gx = px < 0 ? 0 : px > width - 0.001 ? width - 0.001 : px
    let gy = py - 0.5
    gy = gy < 0 ? 0 : gy > height - 1.001 ? height - 1.001 : gy
    const x0 = gx | 0
    const y0 = gy | 0
    const fx = gx - x0
    const fy = gy - y0
    const a = y0 * stride + x0
    return (field[a] * (1 - fx) + field[a + 1] * fx) * (1 - fy) + (field[a + stride] * (1 - fx) + field[a + stride + 1] * fx) * fy
  }

  /** Vertical speed at a point. */
  private sampleV(field: Float32Array, px: number, py: number): number {
    const { width, height } = this
    let gx = px - 0.5
    gx = gx < 0 ? 0 : gx > width - 1.001 ? width - 1.001 : gx
    const gy = py < 0 ? 0 : py > height - 0.001 ? height - 0.001 : py
    const x0 = gx | 0
    const y0 = gy | 0
    const fx = gx - x0
    const fy = gy - y0
    const a = y0 * width + x0
    return (field[a] * (1 - fx) + field[a + 1] * fx) * (1 - fy) + (field[a + width] * (1 - fx) + field[a + width + 1] * fx) * fy
  }

  /** Semi-Lagrangian advection: each face takes the speed of the air that arrives there. */
  private advectVelocity(dt: number): void {
    const { width, height, u, v, u0, v0 } = this
    const stride = width + 1
    u0.set(u)
    v0.set(v)
    for (let y = 0; y < height; y++) {
      for (let x = 1; x <= width; x++) {
        const px = x
        const py = y + 0.5
        const fromX = px - u0[y * stride + x] * dt
        const fromY = py - this.sampleV(v0, px, py) * dt
        u[y * stride + x] = this.sampleU(u0, fromX, fromY)
      }
    }
    for (let y = 1; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const px = x + 0.5
        const py = y
        const fromX = px - this.sampleU(u0, px, py) * dt
        const fromY = py - v0[y * width + x] * dt
        v[y * width + x] = this.sampleV(v0, fromX, fromY)
      }
    }
  }

  private advectSmoke(dt: number): void {
    const { width, height, smoke, smoke0, centerU, centerV, solid } = this
    smoke0.set(smoke)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        if (solid[i]) {
          smoke[i] = 0
          continue
        }
        let px = x - centerU[i] * dt
        let py = y - centerV[i] * dt
        px = px < 0 ? 0 : px > width - 1.001 ? width - 1.001 : px
        py = py < 0 ? 0 : py > height - 1.001 ? height - 1.001 : py
        const x0 = px | 0
        const y0 = py | 0
        const fx = px - x0
        const fy = py - y0
        const a = y0 * width + x0
        smoke[i] =
          ((smoke0[a] * (1 - fx) + smoke0[a + 1] * fx) * (1 - fy) + (smoke0[a + width] * (1 - fx) + smoke0[a + width + 1] * fx) * fy) * 0.9985
      }
    }
  }

  /**
   * Remove divergence: solve for the pressure that balances the flow through
   * every cell, then subtract its gradient from the face speeds. Walls, the
   * inlet and the body let nothing through; the outlet is open (pressure 0).
   */
  private project(): void {
    const { width, height, u, v, solid, pressure } = this
    const stride = width + 1
    const omega = 1.8
    for (let sweep = 0; sweep < this.iterations; sweep++) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x
          if (solid[i]) continue
          let sum = 0
          let count = 0
          if (x > 0 && !solid[i - 1]) {
            sum += pressure[i - 1]
            count++
          }
          if (x === width - 1) count++
          else if (!solid[i + 1]) {
            sum += pressure[i + 1]
            count++
          }
          if (y > 0 && !solid[i - width]) {
            sum += pressure[i - width]
            count++
          }
          if (y < height - 1 && !solid[i + width]) {
            sum += pressure[i + width]
            count++
          }
          if (count === 0) continue
          const face = y * stride + x
          const divergence = u[face + 1] - u[face] + v[i + width] - v[i]
          pressure[i] += omega * ((sum - divergence) / count - pressure[i])
        }
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        if (solid[i]) continue
        if (x > 0 && !solid[i - 1]) u[y * stride + x] -= pressure[i] - pressure[i - 1]
        if (x === width - 1) u[y * stride + width] += pressure[i]
        if (y > 0 && !solid[i - width]) v[i] -= pressure[i] - pressure[i - width]
      }
    }
  }

  /** Cell-centered velocity and spin, from the face speeds. */
  private updateCenters(): void {
    const { width, height, u, v, centerU, centerV, curl } = this
    const stride = width + 1
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        centerU[i] = 0.5 * (u[y * stride + x] + u[y * stride + x + 1])
        centerV[i] = 0.5 * (v[i] + v[i + width])
      }
    }
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x
        curl[i] = 0.5 * (centerV[i + 1] - centerV[i - 1] - (centerU[i + width] - centerU[i - width]))
      }
    }
  }

  /** Feed energy back into existing eddies, which the advection step otherwise smooths out. */
  private confineVorticity(dt: number): void {
    const { width, height, u, v, curl, solid } = this
    const stride = width + 1
    const strength = this.params.turbulence * 6 * dt
    for (let y = 2; y < height - 2; y++) {
      for (let x = 2; x < width - 2; x++) {
        const i = y * width + x
        if (solid[i]) continue
        const gx = 0.5 * (Math.abs(curl[i + 1]) - Math.abs(curl[i - 1]))
        const gy = 0.5 * (Math.abs(curl[i + width]) - Math.abs(curl[i - width]))
        const length = Math.hypot(gx, gy) + 1e-5
        const forceX = strength * (gy / length) * curl[i]
        const forceY = -strength * (gx / length) * curl[i]
        // Share each cell's push between the faces on either side of it.
        u[y * stride + x] += forceX * 0.5
        u[y * stride + x + 1] += forceX * 0.5
        v[i] += forceY * 0.5
        v[i + width] += forceY * 0.5
      }
    }
  }

  /** A rake of nozzles at the inlet lays evenly spaced smoke lines into the flow. */
  private emitSmoke(): void {
    const { width, height, smoke } = this
    const spacing = Math.max(4, Math.round(height / 12))
    for (let y = 1; y < height - 1; y++) {
      const nozzle = y % spacing < Math.max(1, Math.round(spacing * 0.3))
      if (!nozzle && this.burstTime <= 0) continue
      smoke[y * width + 1] = 1
      smoke[y * width + 2] = 1
    }
  }

  /**
   * Lift and drag from pressure on the body's surface. Each air cell touching
   * the body pushes on it with its pressure, in the direction of the body.
   * Coefficients are normalized by ½·U²·chord.
   */
  private measureForces(dt: number): void {
    const { width, height, solid, pressure } = this
    let fx = 0
    let fy = 0
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x
        if (solid[i]) continue
        const p = pressure[i]
        if (solid[i + 1]) fx += p
        if (solid[i - 1]) fx -= p
        if (solid[i + width]) fy += p
        if (solid[i - width]) fy -= p
      }
    }
    // The projection's pressure has the timestep folded in; divide it back out.
    const scale = 1 / (dt * 0.5 * this.params.wind * this.params.wind * this.chord)
    // Vortex shedding makes the raw forces swing; the reading follows them slowly, like a damped balance.
    const blend = Math.min(1, dt * 1.2)
    this.drag += (fx * scale - this.drag) * blend
    this.lift += (fy * scale - this.lift) * blend
  }
}
