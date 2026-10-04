import { describe, expect, it } from 'vitest'
import { ShakeTableModel, type ShakeParams } from './ShakeTableModel'

const defaults: ShakeParams = { frequency: 1, amplitude: 0.05, damping: 6, damper: false, tuning: 1 }

function run(params: ShakeParams, seconds = 40): ShakeTableModel {
  const model = new ShakeTableModel(params)
  for (let i = 0; i < seconds * 60; i++) model.step(1 / 60)
  return model
}

describe('ShakeTableModel', () => {
  it('starts at rest when there is no ground motion', () => {
    const model = run({ ...defaults, amplitude: 0 })
    expect(model.floors).toEqual([0, 0, 0])
    expect(model.peakRoof).toBe(0)
  })

  it('amplifies motion near the first natural frequency', () => {
    const resonant = run(defaults)
    const offResonance = run({ ...defaults, frequency: 0.3 })
    expect(resonant.peakRoof).toBeGreaterThan(offResonance.peakRoof * 3)
  })

  it('reduces roof sway when the roof mass is tuned to resonance', () => {
    const bare = run(defaults)
    const tuned = run({ ...defaults, damper: true })
    expect(tuned.peakRoof).toBeLessThan(bare.peakRoof * 0.8)
  })

  it('repeats the same motion and clears peaks on reset', () => {
    const model = run(defaults, 5)
    const roof = model.roofX
    model.reset()
    for (let i = 0; i < 5 * 60; i++) model.step(1 / 60)
    expect(model.roofX).toBeCloseTo(roof, 9)
    model.reset()
    expect(model.peakRoof).toBe(0)
    expect(model.peakAcceleration).toBe(0)
    expect(model.peakStoryDrift).toBe(0)
  })
})
