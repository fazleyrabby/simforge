import { describe, expect, it } from 'vitest'
import { Rng } from '../core/random'
import { STEP } from '../core/Simulation'
import { FactoryLogic, MIN_GAP, type FactoryParams, type ProductState } from './FactoryLogic'

const params: FactoryParams = {
  spawnRate: 60,
  conveyorSpeed: 2,
  machineSpeed: 1,
  ovenTemp: 180,
  failures: false,
  mtbf: 45,
}

function run(logic: FactoryLogic, seconds: number, each?: () => void): void {
  for (let i = 0; i < seconds / STEP; i++) {
    logic.step(STEP)
    each?.()
  }
}

describe('FactoryLogic', () => {
  it('moves every product through the lifecycle in order', () => {
    const logic = new FactoryLogic(new Rng(1), 1, { ...params })
    const order: ProductState[] = ['raw', 'mixed', 'shaped', 'baking', 'cooling', 'packaged']
    const seen = new Map<number, number>()
    run(logic, 60, () => {
      for (const product of logic.lanes[0]) {
        const rank = order.indexOf(product.state)
        const previous = seen.get(product.id) ?? 0
        expect(rank).toBeGreaterThanOrEqual(previous)
        expect(rank - previous).toBeLessThanOrEqual(1)
        seen.set(product.id, rank)
      }
    })
    expect(logic.completed).toBeGreaterThan(10)
    expect(logic.productionPerMinute()).toBeGreaterThan(20)
  })

  it('backs the line up behind a jam without overlapping products', () => {
    const logic = new FactoryLogic(new Rng(1), 1, { ...params })
    run(logic, 30)
    const before = logic.completed
    logic.jam(logic.machineAt(0, 'cutter').id, 1000)
    run(logic, 40, () => {
      const lane = logic.lanes[0]
      for (let i = 1; i < lane.length; i++) {
        expect(lane[i - 1].s - lane[i].s).toBeGreaterThanOrEqual(MIN_GAP - 1e-6)
      }
    })
    // Everything past the cutter drains out, then production stops.
    const drained = logic.completed
    run(logic, 20)
    expect(logic.completed).toBe(drained)
    expect(drained).toBeGreaterThan(before)
    expect(logic.lanes[0].every((product) => product.s <= 9 + 1e-6)).toBe(true)
    expect(logic.machineAt(0, 'dispenser').status).toBe('blocked')
    expect(logic.downtime).toBeGreaterThan(59)

    logic.repair(logic.machineAt(0, 'cutter').id)
    run(logic, 30)
    expect(logic.completed).toBeGreaterThan(drained)
  })

  it('is reproducible from a seed, failures included', () => {
    const snapshot = (seed: number) => {
      const logic = new FactoryLogic(new Rng(seed), 2, { ...params, failures: true, mtbf: 10 })
      run(logic, 90)
      return [logic.completed, logic.downtime, logic.lanes.map((lane) => lane.map((product) => product.s))]
    }
    expect(snapshot(42)).toEqual(snapshot(42))
    expect(snapshot(42)).not.toEqual(snapshot(43))
  })
})
