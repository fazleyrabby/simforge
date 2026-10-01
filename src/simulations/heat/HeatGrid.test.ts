import { describe, expect, it } from 'vitest'
import { HeatGrid } from './HeatGrid'

function total(grid: HeatGrid): number {
  return grid.average() * grid.size * grid.size
}

describe('HeatGrid', () => {
  it('conserves heat when nothing is cooling or held', () => {
    const grid = new HeatGrid(32)
    grid.inject(16, 16, 4, 1)
    const before = total(grid)
    for (let i = 0; i < 500; i++) grid.step(0.24, 0)
    expect(total(grid)).toBeCloseTo(before, 3)
  })

  it('spreads heat outward and flattens the peak', () => {
    const grid = new HeatGrid(32)
    grid.inject(16, 16, 2, 1)
    const peak = grid.max()
    const corner = grid.temperature[0]
    for (let i = 0; i < 2000; i++) grid.step(0.24, 0)
    expect(grid.max()).toBeLessThan(peak * 0.1)
    expect(grid.temperature[0]).toBeGreaterThan(corner)
    // With insulated edges the plate ends up uniform.
    expect(grid.max() - grid.temperature[0]).toBeLessThan(0.002)
  })

  it('stays symmetric around a centered source', () => {
    const grid = new HeatGrid(33)
    grid.paint(16.5, 16.5, 1, 1)
    for (let i = 0; i < 200; i++) grid.step(0.2, 0.001)
    const at = (x: number, y: number) => grid.temperature[y * 33 + x]
    expect(at(10, 16)).toBeCloseTo(at(22, 16), 6)
    expect(at(16, 10)).toBeCloseTo(at(16, 22), 6)
    expect(at(10, 16)).toBeCloseTo(at(16, 10), 6)
  })

  it('holds sources at temperature and loses heat to cooling', () => {
    const held = new HeatGrid(24)
    held.paint(12, 12, 2, 0.8)
    for (let i = 0; i < 300; i++) held.step(0.24, 0.01)
    expect(held.max()).toBeCloseTo(0.8, 6)

    const free = new HeatGrid(24)
    free.inject(12, 12, 4, 1)
    const before = total(free)
    for (let i = 0; i < 300; i++) free.step(0.24, 0.01)
    expect(total(free)).toBeLessThan(before * 0.1)
  })

  it('erases sources and keeps the field when resampled', () => {
    const grid = new HeatGrid(32)
    grid.paint(8, 8, 3, 1)
    const larger = grid.resample(64)
    expect(larger.size).toBe(64)
    expect(larger.temperature[16 * 64 + 16]).toBe(1)
    expect(larger.source[16 * 64 + 16]).toBe(1)
    grid.erase(8, 8, 5)
    expect(grid.max()).toBe(0)
  })
})
