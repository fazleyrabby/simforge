import { describe, expect, it } from 'vitest'
import { Rng } from '../core/random'
import { STEP } from '../core/Simulation'
import {
  QUEUE_MAX,
  RackLogic,
  T_AMBIENT,
  T_CRIT,
  T_THROTTLE,
  coolingRate,
  steadyTemp,
  throttleFactor,
  type RackParams,
} from './RackLogic'

const params: RackParams = {
  arrivalRate: 240,
  jobSize: 140,
  cooling: 0.7,
  powerCap: 12,
  failures: false,
}

function run(logic: RackLogic, seconds: number, each?: () => void): void {
  for (let i = 0; i < seconds / STEP; i++) {
    logic.step(STEP)
    each?.()
  }
}

describe('throttleFactor', () => {
  it('runs at full capacity until the throttle temperature', () => {
    expect(throttleFactor(T_AMBIENT)).toBe(1)
    expect(throttleFactor(T_THROTTLE)).toBe(1)
  })

  it('drops to the floor at the critical temperature and never below', () => {
    expect(throttleFactor(T_CRIT)).toBeCloseTo(0.4)
    expect(throttleFactor(T_CRIT + 50)).toBe(0.4)
    expect(throttleFactor((T_THROTTLE + T_CRIT) / 2)).toBeCloseTo(0.7)
  })
})

describe('RackLogic', () => {
  it('processes jobs and conserves every arrival', () => {
    const logic = new RackLogic(new Rng(1), 8, { ...params })
    run(logic, 40, () => {
      expect(logic.arrived).toBe(
        logic.completed + logic.dropped + logic.queue.length + logic.runningJobs,
      )
    })
    expect(logic.completed).toBeGreaterThan(20)
    expect(logic.throughput()).toBeGreaterThan(0)
    expect(logic.avgLatency()).toBeGreaterThan(0)
  })

  it('reaches the predicted steady temperature under a held full load', () => {
    const held: RackParams = { ...params, arrivalRate: 100000, jobSize: 100000, failures: false }
    const logic = new RackLogic(new Rng(1), 1, held)
    run(logic, 60)
    const node = logic.nodes[0]
    expect(node.jobs.length).toBe(node.slots)
    // Busy node settles near steady state for its throttled power draw.
    const factor = throttleFactor(node.temp)
    const power = 0.08 + factor * (0.46 - 0.08)
    expect(node.temp).toBeCloseTo(steadyTemp(power, held.cooling), 0)
    expect(coolingRate(0)).toBeLessThan(coolingRate(1))
  })

  it('never exceeds the PDU budget and backs the queue up instead', () => {
    const capped: RackParams = { ...params, arrivalRate: 600, powerCap: 2 }
    const logic = new RackLogic(new Rng(2), 8, capped)
    let peakPower = 0
    run(logic, 30, () => {
      peakPower = Math.max(peakPower, logic.totalPower)
      expect(logic.totalPower).toBeLessThanOrEqual(capped.powerCap + 1e-6)
    })
    expect(peakPower).toBeGreaterThan(0)
    // A tight cap starves the rack, so work piles up in the queue.
    expect(logic.queue.length).toBeGreaterThan(20)
  })

  it('sheds load once the backlog overflows', () => {
    const flood: RackParams = { ...params, arrivalRate: 6000, powerCap: 4 }
    const logic = new RackLogic(new Rng(3), 6, flood)
    run(logic, 40)
    expect(logic.queue.length).toBeLessThanOrEqual(QUEUE_MAX)
    expect(logic.dropped).toBeGreaterThan(0)
  })

  it('overheats nodes without cooling and keeps them cool with it', () => {
    const hot = new RackLogic(new Rng(4), 6, { ...params, cooling: 0, failures: true })
    run(hot, 60)
    expect(hot.nodes.some((node) => node.status === 'down')).toBe(true)

    const cold = new RackLogic(new Rng(4), 6, { ...params, cooling: 1, failures: true })
    run(cold, 60)
    expect(cold.nodes.every((node) => node.temp < T_CRIT)).toBe(true)
    expect(cold.runningNodes).toBe(cold.nodes.length)
  })

  it('reboots a crashed node and returns its work to the queue', () => {
    const logic = new RackLogic(new Rng(5), 4, { ...params })
    run(logic, 10)
    const node = logic.nodes[0]
    const queued = logic.queue.length + node.jobs.length
    ;(logic as unknown as { crash(n: typeof node): void }).crash(node)
    expect(node.status).toBe('down')
    expect(node.jobs.length).toBe(0)
    // Its in-flight work is now back in the queue, nothing lost.
    expect(logic.queue.length).toBe(queued)
    logic.reboot(node.id)
    expect(node.status).toBe('idle')
  })

  it('is reproducible from a seed, failures included', () => {
    const snapshot = (seed: number) => {
      const logic = new RackLogic(new Rng(seed), 6, { ...params, cooling: 0.35, failures: true })
      run(logic, 90)
      return [
        logic.completed,
        logic.dropped,
        logic.nodes.map((node) => [node.jobs.length, Math.round(node.temp)]),
      ]
    }
    expect(snapshot(21)).toEqual(snapshot(21))
    expect(snapshot(21)).not.toEqual(snapshot(22))
  })
})
