import { describe, expect, it } from 'vitest'
import { Rng } from '../core/random'
import { STEP } from '../core/Simulation'
import { FluidGrid, shapeOutline, type ShapeKind } from './FluidGrid'

const WIND = 22

function make(kind: ShapeKind | null, angle = 0, seed = 1): FluidGrid {
  const grid = new FluidGrid(96, 48, new Rng(seed), { wind: WIND, turbulence: 0.35 })
  if (kind) grid.setBody(kind, angle)
  return grid
}

/** Runs the flow and returns lift and drag averaged over the second half. */
function settle(grid: FluidGrid, seconds: number): { lift: number; drag: number } {
  const steps = Math.round(seconds / STEP)
  let lift = 0
  let drag = 0
  let samples = 0
  for (let i = 0; i < steps; i++) {
    grid.step(STEP)
    if (i >= steps / 2) {
      lift += grid.lift
      drag += grid.drag
      samples++
    }
  }
  return { lift: lift / samples, drag: drag / samples }
}

describe('FluidGrid', () => {
  it('conserves mass: flow into every open cell equals flow out', () => {
    const grid = make('cylinder')
    let worst = 0
    for (let i = 0; i < 600; i++) {
      grid.step(STEP)
      if (i > 120) worst = Math.max(worst, grid.maxDivergence())
    }
    // Under a tenth of a percent of the wind speed.
    expect(worst).toBeLessThan(WIND * 0.001)
  })

  it('lets no air through the body', () => {
    const grid = make('airfoil', 10)
    for (let i = 0; i < 300; i++) grid.step(STEP)
    let solids = 0
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        if (!grid.solid[y * grid.width + x]) continue
        solids++
        const face = y * (grid.width + 1) + x
        expect(grid.u[face]).toBe(0)
        expect(grid.u[face + 1]).toBe(0)
        expect(grid.v[y * grid.width + x]).toBe(0)
        expect(grid.v[(y + 1) * grid.width + x]).toBe(0)
      }
    }
    expect(solids).toBeGreaterThan(40)
  })

  it('keeps an empty tunnel in uniform flow', () => {
    const grid = make(null)
    for (let i = 0; i < 600; i++) grid.step(STEP)
    for (let i = 0; i < grid.centerU.length; i++) {
      expect(grid.centerU[i]).toBeCloseTo(WIND, 0)
      expect(Math.abs(grid.centerV[i])).toBeLessThan(WIND * 0.03)
    }
    expect(grid.drag).toBe(0)
  })

  it('speeds the air up as it squeezes past a body', () => {
    const grid = make('cylinder')
    for (let i = 0; i < 400; i++) grid.step(STEP)
    expect(grid.peakSpeed()).toBeGreaterThan(1.5)
  })

  it('gives a symmetric body drag but no net lift', () => {
    const { lift, drag } = settle(make('cylinder'), 16)
    expect(drag).toBeGreaterThan(0.8)
    expect(Math.abs(lift)).toBeLessThan(drag * 0.15)
  }, 30000)

  it('turns angle of attack into lift, in the direction of the pitch', () => {
    const level = settle(make('airfoil', 0), 12)
    const up = settle(make('airfoil', 14), 12)
    const down = settle(make('airfoil', -14), 12)
    expect(Math.abs(level.lift)).toBeLessThan(0.05)
    expect(up.lift).toBeGreaterThan(0.25)
    expect(down.lift).toBeLessThan(-0.25)
    // Pitching either way costs drag.
    expect(up.drag).toBeGreaterThan(level.drag * 2)
  }, 30000)

  it('makes a blunt body drag far more than a streamlined one', () => {
    const airfoil = settle(make('airfoil', 0), 12)
    const cylinder = settle(make('cylinder', 0), 12)
    expect(cylinder.drag).toBeGreaterThan(airfoil.drag * 5)
  }, 30000)

  it('keeps smoke between 0 and 1 and carries it downstream', () => {
    const grid = make('wedge')
    for (let i = 0; i < 400; i++) grid.step(STEP)
    let downstream = 0
    for (let i = 0; i < grid.smoke.length; i++) {
      expect(grid.smoke[i]).toBeGreaterThanOrEqual(0)
      expect(grid.smoke[i]).toBeLessThanOrEqual(1)
      if (i % grid.width > grid.width * 0.8) downstream += grid.smoke[i]
    }
    expect(downstream).toBeGreaterThan(5)
  })

  it('draws outlines the solver and the renderer can share', () => {
    for (const kind of ['airfoil', 'cylinder', 'plate', 'wedge'] as ShapeKind[]) {
      const outline = shapeOutline(kind)
      expect(outline.length).toBeGreaterThanOrEqual(3)
      for (const [x, y] of outline) {
        expect(Math.abs(x)).toBeLessThanOrEqual(0.5)
        expect(Math.abs(y)).toBeLessThanOrEqual(0.5)
      }
    }
  })

  it('is reproducible from a seed', () => {
    const snapshot = (seed: number) => {
      const grid = make('cylinder', 0, seed)
      for (let i = 0; i < 300; i++) grid.step(STEP)
      return [grid.lift, grid.drag, grid.centerV[grid.width * 24 + 60]]
    }
    expect(snapshot(3)).toEqual(snapshot(3))
    expect(snapshot(3)).not.toEqual(snapshot(4))
  })
})
