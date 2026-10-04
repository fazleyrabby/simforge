import { describe, expect, it } from 'vitest'
import { MaglevModel, type MaglevParams } from './MaglevModel'

const defaults: MaglevParams = { mode: 'auto', target: 0.8, current: 0, gain: 1, mass: 0.08 }

function advance(model: MaglevModel, seconds: number): void {
  for (let i = 0; i < seconds * 60; i++) model.step(1 / 60)
}

describe('MaglevModel', () => {
  it('holds the ball near the target with feedback', () => {
    const model = new MaglevModel(defaults)
    advance(model, 8)
    expect(Math.abs(model.error)).toBeLessThan(0.035)
    expect(Math.abs(model.velocity)).toBeLessThan(0.08)
    expect(model.status).toBe('STABLE')
  })

  it('lets the ball fall into the catch tray with no current', () => {
    const model = new MaglevModel({ ...defaults, mode: 'manual', current: 0 })
    advance(model, 3)
    expect(model.catches).toBeGreaterThan(0)
  })

  it('recovers from a downward tap', () => {
    const model = new MaglevModel(defaults)
    advance(model, 3)
    model.nudge()
    advance(model, 6)
    expect(Math.abs(model.error)).toBeLessThan(0.06)
    expect(model.catches).toBe(0)
  })

  it('follows a changed target and resets reproducibly', () => {
    const model = new MaglevModel(defaults)
    advance(model, 2)
    model.params = { ...defaults, target: 1.15 }
    advance(model, 8)
    expect(Math.abs(model.gap - 1.15)).toBeLessThan(0.05)
    model.reset()
    expect(model.gap).toBeCloseTo(1.21)
    expect(model.peakError).toBe(0)
  })
})
