import type { Rng } from '../core/random'

export interface Body {
  id: number
  mass: number
  /** Position in the orbital plane. */
  x: number
  y: number
  vx: number
  vy: number
  /** Acceleration, carried between the two half-kicks of one Verlet step. */
  ax: number
  ay: number
  /** Visual radius; has no effect on the physics. */
  radius: number
  star: boolean
  /** Radius the body was launched at, for reference. */
  orbitRadius: number
}

export interface OrbitalParams {
  /** Gravitational constant multiplier. Scales every orbital speed. */
  gravity: number
  /** Spread of orbit ellipticity, 0 (circular) to ~0.6. */
  eccentricity: number
}

/** Gravitational constant at a gravity setting of 1. */
export const G0 = 1
const STAR_MASS = 1200
/** Softening length so a close pass never diverges. */
const SOFTENING = 0.08

/**
 * An N-body gravitational system in a plane, independent of rendering.
 *
 * Every body attracts every other by Newton's law and the state is advanced
 * with velocity Verlet, a symplectic integrator that conserves energy over
 * long runs instead of letting orbits spiral in or out. A planet launched at
 * the circular speed sqrt(G·M/r) therefore holds its radius, and the system's
 * total energy and angular momentum stay put. The star dominates, so planets
 * trace Kepler ellipses while perturbing one another slightly.
 */
export class OrbitalSystem {
  readonly bodies: Body[] = []
  time = 0

  constructor(
    private rng: Rng,
    planetCount: number,
    public params: OrbitalParams,
  ) {
    this.bodies.push({
      id: 0,
      mass: STAR_MASS,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      ax: 0,
      ay: 0,
      radius: 1.1,
      star: true,
      orbitRadius: 0,
    })

    let r = 3.2
    for (let i = 0; i < planetCount; i++) {
      r += rng.range(1.3, 2.4)
      const angle = rng.range(0, Math.PI * 2)
      const mass = rng.range(1, 9)
      // Circular speed for the star's pull, nudged to set the eccentricity.
      const speed = Math.sqrt((this.G * STAR_MASS) / r) * (1 + rng.range(-1, 1) * params.eccentricity * 0.5)
      // Velocity perpendicular to the radius gives a closed orbit.
      const dir = rng.chance(0.5) ? 1 : -1
      this.bodies.push({
        id: i + 1,
        mass,
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
        vx: -Math.sin(angle) * speed * dir,
        vy: Math.cos(angle) * speed * dir,
        ax: 0,
        ay: 0,
        radius: 0.18 + Math.cbrt(mass) * 0.12,
        star: false,
        orbitRadius: r,
      })
    }

    // Give the star the recoil that cancels the planets' momentum, so the
    // system's centre of mass stays put instead of drifting out of view.
    const star = this.bodies[0]
    for (const body of this.bodies) {
      if (body.star) continue
      star.vx -= (body.mass * body.vx) / star.mass
      star.vy -= (body.mass * body.vy) / star.mass
    }

    this.computeAccelerations()
  }

  get G(): number {
    return G0 * this.params.gravity
  }

  /** Advance the whole system by one velocity-Verlet step of size h seconds. */
  step(h: number): void {
    const bodies = this.bodies
    for (const body of bodies) {
      body.vx += 0.5 * h * body.ax
      body.vy += 0.5 * h * body.ay
      body.x += h * body.vx
      body.y += h * body.vy
    }
    this.computeAccelerations()
    for (const body of bodies) {
      body.vx += 0.5 * h * body.ax
      body.vy += 0.5 * h * body.ay
    }
    this.time += h
  }

  /**
   * Advance by `total` seconds, splitting it into steps short enough for the
   * tightest pair in the system: a fixed fraction of the pair's local orbital
   * time √(d³ / G(m₁+m₂)). A comet at perihelion, or two planets brushing past
   * each other, therefore get finer steps than the quiet stretches need.
   */
  advance(total: number, maxStep: number): void {
    const bodies = this.bodies
    let remaining = total
    let guard = 0
    while (remaining > 1e-9 && guard++ < 400) {
      let tightest = Infinity
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          const dx = bodies[j].x - bodies[i].x
          const dy = bodies[j].y - bodies[i].y
          const d2 = dx * dx + dy * dy + SOFTENING * SOFTENING
          tightest = Math.min(tightest, (d2 * Math.sqrt(d2)) / (this.G * (bodies[i].mass + bodies[j].mass)))
        }
      }
      const h = Math.min(remaining, maxStep, 0.02 * Math.sqrt(tightest))
      this.step(h)
      remaining -= h
    }
  }

  /** Launch a fast, eccentric body from the outer edge: a passing comet. */
  addComet(): Body {
    const star = this.bodies[0]
    const outer = this.bodies.reduce((max, body) => Math.max(max, Math.hypot(body.x - star.x, body.y - star.y)), 4)
    const r = outer + this.rng.range(3, 6)
    const angle = this.rng.range(0, Math.PI * 2)
    // Position and velocity are set relative to the star, wherever it has wandered.
    const x = star.x + Math.cos(angle) * r
    const y = star.y + Math.sin(angle) * r
    // Start at the far point of a Kepler ellipse whose near point clears the
    // star: from vis-viva, speed at aphelion r for perihelion q is √(GM·2q / (r(r+q))).
    const perihelion = this.rng.range(1.8, 3)
    const speed = Math.sqrt((this.G * STAR_MASS * 2 * perihelion) / (r * (r + perihelion)))
    const dir = this.rng.chance(0.5) ? 1 : -1
    const comet: Body = {
      id: this.bodies.length,
      mass: this.rng.range(0.2, 1),
      x,
      y,
      vx: star.vx - Math.sin(angle) * speed * dir,
      vy: star.vy + Math.cos(angle) * speed * dir,
      ax: 0,
      ay: 0,
      radius: 0.12,
      star: false,
      orbitRadius: r,
    }
    this.bodies.push(comet)
    this.computeAccelerations()
    return comet
  }

  /** Total kinetic + (softened) gravitational potential energy. */
  totalEnergy(): number {
    let energy = 0
    for (const body of this.bodies) {
      energy += 0.5 * body.mass * (body.vx * body.vx + body.vy * body.vy)
    }
    for (let i = 0; i < this.bodies.length; i++) {
      for (let j = i + 1; j < this.bodies.length; j++) {
        const a = this.bodies[i]
        const b = this.bodies[j]
        const dist = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + SOFTENING ** 2)
        energy -= (this.G * a.mass * b.mass) / dist
      }
    }
    return energy
  }

  /** Scalar angular momentum about the origin (the plane normal component). */
  angularMomentum(): number {
    let total = 0
    for (const body of this.bodies) total += body.mass * (body.x * body.vy - body.y * body.vx)
    return total
  }

  private computeAccelerations(): void {
    const bodies = this.bodies
    for (const body of bodies) {
      body.ax = 0
      body.ay = 0
    }
    const g = this.G
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i]
        const b = bodies[j]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const r2 = dx * dx + dy * dy + SOFTENING * SOFTENING
        const inv = 1 / (r2 * Math.sqrt(r2))
        const fa = g * b.mass * inv
        const fb = g * a.mass * inv
        a.ax += dx * fa
        a.ay += dy * fa
        b.ax -= dx * fb
        b.ay -= dy * fb
      }
    }
  }
}
