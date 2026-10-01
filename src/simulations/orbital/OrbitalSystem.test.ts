import { describe, expect, it } from 'vitest'
import { Rng } from '../core/random'
import { G0, OrbitalSystem, type OrbitalParams } from './OrbitalSystem'

const circular: OrbitalParams = { gravity: 1, eccentricity: 0 }

function run(system: OrbitalSystem, seconds: number, h = 1 / 240): void {
  for (let i = 0; i < Math.round(seconds / h); i++) system.step(h)
}

/** Separation from the star, which itself recoils, so the origin is not the focus. */
function radius(system: OrbitalSystem, id: number): number {
  const body = system.bodies[id]
  const star = system.bodies[0]
  return Math.hypot(body.x - star.x, body.y - star.y)
}

describe('OrbitalSystem', () => {
  it('launches planets at the circular orbital speed sqrt(G·M/r)', () => {
    const system = new OrbitalSystem(new Rng(1), 3, circular)
    const gm = G0 * system.bodies[0].mass
    for (const planet of system.bodies.slice(1)) {
      const r = Math.hypot(planet.x, planet.y)
      const speed = Math.hypot(planet.vx, planet.vy)
      expect(speed).toBeCloseTo(Math.sqrt(gm / r), 5)
    }
  })

  it('holds a circular orbit at constant radius over several revolutions', () => {
    const system = new OrbitalSystem(new Rng(7), 1, circular)
    const r0 = radius(system, 1)
    let min = r0
    let max = r0
    run(system, 30)
    for (let i = 0; i < 2000; i++) {
      system.step(1 / 240)
      const r = radius(system, 1)
      min = Math.min(min, r)
      max = Math.max(max, r)
    }
    // Radius wanders by at most a few percent, with no secular drift.
    expect((max - min) / r0).toBeLessThan(0.05)
  })

  it('follows Kepler\'s third law across planets (T² ∝ a³)', () => {
    // A lone planet per system traces a clean ellipse; period from radial returns.
    const periodAt = (r: number): { a: number; period: number } => {
      const system = new OrbitalSystem(new Rng(3), 0, circular)
      const gm = G0 * system.bodies[0].mass
      const speed = Math.sqrt(gm / r)
      system.bodies.push({
        id: 1, mass: 1, x: r, y: 0, vx: 0, vy: speed, ax: 0, ay: 0, radius: 0.2, star: false, orbitRadius: r,
      })
      ;(system as unknown as { computeAccelerations(): void }).computeAccelerations()
      const h = 1 / 480
      let t0 = -1
      for (let i = 0; i < Math.round(20 / h); i++) {
        const before = system.bodies[1].y
        system.step(h)
        const after = system.bodies[1].y
        // Crossing y = 0 upward marks a full revolution.
        if (before < 0 && after >= 0 && system.bodies[1].x > 0) {
          if (t0 < 0) t0 = system.time
          else return { a: r, period: system.time - t0 }
        }
      }
      throw new Error('no period found')
    }
    const inner = periodAt(4)
    const outer = periodAt(8)
    const ratio = outer.period ** 2 / outer.a ** 3 / (inner.period ** 2 / inner.a ** 3)
    expect(ratio).toBeCloseTo(1, 1)
  })

  it('conserves total energy over a long integration', () => {
    const system = new OrbitalSystem(new Rng(11), 4, { gravity: 1, eccentricity: 0.25 })
    const e0 = system.totalEnergy()
    // Stepped the way the simulation steps it: finer whenever two bodies pass close.
    for (let i = 0; i < 120 * 60; i++) system.advance(1 / 60, 1 / 60)
    const drift = Math.abs((system.totalEnergy() - e0) / e0)
    expect(drift).toBeLessThan(0.02)
  })

  it('conserves angular momentum over a long integration', () => {
    const system = new OrbitalSystem(new Rng(13), 4, { gravity: 1, eccentricity: 0.3 })
    const l0 = system.angularMomentum()
    run(system, 120)
    expect(Math.abs(system.angularMomentum() - l0)).toBeLessThan(Math.abs(l0) * 0.01 + 1e-6)
  })

  it('keeps gravity pulling: a stationary planet falls toward the star', () => {
    const system = new OrbitalSystem(new Rng(1), 0, circular)
    system.bodies.push({
      id: 1, mass: 1, x: 6, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, radius: 0.2, star: false, orbitRadius: 6,
    })
    ;(system as unknown as { computeAccelerations(): void }).computeAccelerations()
    const r0 = radius(system, 1)
    // Short enough that it is still falling, not yet slung back out past the star.
    run(system, 0.12)
    expect(radius(system, 1)).toBeLessThan(r0)
  })

  it('is reproducible from a seed', () => {
    const snapshot = (seed: number) => {
      const system = new OrbitalSystem(new Rng(seed), 5, { gravity: 1, eccentricity: 0.2 })
      run(system, 40)
      return system.bodies.map((body) => [Math.round(body.x * 1e3), Math.round(body.y * 1e3)])
    }
    expect(snapshot(99)).toEqual(snapshot(99))
    expect(snapshot(99)).not.toEqual(snapshot(100))
  })

  it('carries a comet through perihelion without gaining energy or hitting the star', () => {
    const system = new OrbitalSystem(new Rng(21), 4, { gravity: 1, eccentricity: 0.2 })
    const comet = system.addComet()
    const star = system.bodies[0]
    const before = system.totalEnergy()
    const distance = () => Math.hypot(comet.x - star.x, comet.y - star.y)
    // Follow the comet in to its first closest approach and a little way back out.
    let nearest = distance()
    let outbound = 0
    for (let i = 0; i < 60 * 120 && outbound < 120; i++) {
      system.advance(1.5 / 60, 1 / 60)
      const d = distance()
      if (d < nearest) nearest = d
      else if (d > nearest * 1.05) outbound++
    }
    expect(outbound).toBe(120)
    // Launched for a perihelion of at least 1.8; the star's surface is at 1.1.
    expect(nearest).toBeGreaterThan(1.5)
    expect(Math.abs((system.totalEnergy() - before) / before)).toBeLessThan(0.02)
  })
})
