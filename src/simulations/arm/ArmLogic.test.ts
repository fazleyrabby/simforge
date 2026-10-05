import { describe, expect, it } from 'vitest'
import { Rng } from '../core/random'
import { STEP } from '../core/Simulation'
import { ARM, ArmLogic, BIN_CAPACITY, JOINT_SPEED, ease, forward, jointMoveTime, solveIK, type ArmParams, type Point } from './ArmLogic'

const params: ArmParams = { manual: false, speed: 1, feedRate: 40, target: [2, 1.5, 1] }

function make(seed = 1, overrides: Partial<ArmParams> = {}): ArmLogic {
  return new ArmLogic(new Rng(seed), { ...params, ...overrides })
}

function run(logic: ArmLogic, seconds: number, each?: () => void): void {
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    logic.step(STEP)
    each?.()
  }
}

describe('inverse kinematics', () => {
  it('lands the gripper tip on the requested point', () => {
    const rng = new Rng(4)
    let solved = 0
    for (let i = 0; i < 400; i++) {
      const target: Point = [rng.range(-4, 4), rng.range(0.2, 3.5), rng.range(-4, 4)]
      const joints = solveIK(...target)
      if (!joints) continue
      solved++
      const tip = forward(joints)
      for (let axis = 0; axis < 3; axis++) expect(tip[axis]).toBeCloseTo(target[axis], 9)
    }
    expect(solved).toBeGreaterThan(200)
  })

  it('keeps the tool pointing straight down', () => {
    const joints = solveIK(2.2, 0.9, -1.4)!
    expect(joints[1] + joints[2] + joints[3]).toBeCloseTo(-Math.PI / 2, 9)
  })

  it('bends the elbow upward', () => {
    const [, shoulder, elbow] = solveIK(2.5, 0.8, 0.5)!
    expect(elbow).toBeLessThan(0)
    // The elbow joint sits above the straight line from shoulder to wrist.
    const elbowHeight = ARM.shoulderHeight + ARM.upper * Math.sin(shoulder)
    expect(elbowHeight).toBeGreaterThan(ARM.shoulderHeight)
  })

  it('refuses points it cannot reach', () => {
    expect(solveIK(9, 1, 0)).toBeNull()
    expect(solveIK(0.1, 1, 0.1)).toBeNull()
    expect(solveIK(0, 6, 3)).toBeNull()
  })
})

describe('motion profile', () => {
  it('starts and ends at rest', () => {
    expect(ease(0)).toBe(0)
    expect(ease(1)).toBe(1)
    expect(ease(0.001) / 0.001).toBeLessThan(0.001)
    expect((1 - ease(0.999)) / 0.001).toBeLessThan(0.001)
  })

  it('never asks a joint to exceed its speed limit', () => {
    const limits = JOINT_SPEED
    const from = solveIK(0, 2.2, 2.7)!
    const to = solveIK(-3.2, 0.8, -1.5)!
    const time = jointMoveTime(from, to)
    let peak = [0, 0, 0, 0]
    const steps = 2000
    for (let i = 1; i <= steps; i++) {
      const ds = (ease(i / steps) - ease((i - 1) / steps)) / (time / steps)
      peak = peak.map((value, j) => Math.max(value, Math.abs(to[j] - from[j]) * ds))
    }
    peak.forEach((value, j) => expect(value).toBeLessThanOrEqual(limits[j] * 1.001))
    // And it is not needlessly slow: some joint runs near its limit.
    expect(Math.max(...peak.map((value, j) => value / limits[j]))).toBeGreaterThan(0.6)
  })
})

describe('ArmLogic', () => {
  it('sorts every part onto the pallet of its colour', () => {
    const logic = make(3)
    run(logic, 120)
    expect(logic.placed).toBeGreaterThan(20)
    expect(logic.missorted).toBe(0)
    for (const part of logic.parts) {
      if (part.state === 'placed') expect(part.bin).toBe(part.color)
    }
  })

  it('accounts for every part', () => {
    const logic = make(5, { feedRate: 90 })
    run(logic, 300)
    expect(logic.spawned).toBe(logic.parts.length + logic.shipped)
    expect(logic.shipped).toBeGreaterThan(0)
    expect(logic.shipped % BIN_CAPACITY).toBe(0)
    expect(logic.pallets).toBe(logic.shipped / BIN_CAPACITY)
    for (const bin of logic.bins) expect(bin.count).toBeLessThanOrEqual(BIN_CAPACITY)
  })

  it('moves the gripper in a straight vertical line when picking', () => {
    const logic = make(2)
    let checked = 0
    run(logic, 30, () => {
      if (logic.phase !== 'descendPick' && logic.phase !== 'liftPick') return
      const [x, , z] = logic.tip
      expect(x).toBeCloseTo(0, 6)
      expect(z).toBeCloseTo(2.7, 6)
      checked++
    })
    expect(checked).toBeGreaterThan(20)
  })

  it('keeps joint speeds inside their limits through whole cycles', () => {
    const logic = make(7, { speed: 2, feedRate: 120 })
    let peak = 0
    run(logic, 60, () => (peak = Math.max(peak, logic.effort)))
    // Joint-space moves respect the limits exactly; Cartesian moves are limited by tip speed instead.
    expect(peak).toBeGreaterThan(0.5)
    expect(peak).toBeLessThan(1.6)
  })

  it('works faster at a higher speed setting', () => {
    const slow = make(6, { speed: 0.5, feedRate: 120 })
    const fast = make(6, { speed: 2, feedRate: 120 })
    run(slow, 120)
    run(fast, 120)
    expect(fast.placed).toBeGreaterThan(slow.placed * 2)
    expect(fast.lastCycle).toBeLessThan(slow.lastCycle)
  })

  it('never stacks parts on the belt', () => {
    const logic = make(8, { speed: 0.25, feedRate: 120 })
    run(logic, 60, () => {
      const belt = logic.beltParts
      for (let i = 1; i < belt.length; i++) expect(belt[i - 1].s - belt[i].s).toBeGreaterThan(0.7)
    })
    expect(logic.beltParts.length).toBeGreaterThan(5)
  })

  it('follows a manual target and reports when it is out of reach', () => {
    const logic = make(1, { manual: true, target: [-2.4, 1.2, 1.1] })
    run(logic, 6)
    const tip = logic.tip
    expect(tip[0]).toBeCloseTo(-2.4, 3)
    expect(tip[1]).toBeCloseTo(1.2, 3)
    expect(tip[2]).toBeCloseTo(1.1, 3)
    expect(logic.reachable).toBe(true)

    logic.params = { ...logic.params, target: [8, 1, 0] }
    run(logic, 6)
    expect(logic.reachable).toBe(false)
    // It stretches toward the target instead of freezing.
    expect(Math.hypot(logic.tip[0], logic.tip[2])).toBeGreaterThan(3.8)
  })

  it('lets the operator pick a part by hand and set it on any pallet', () => {
    const logic = make(1, { manual: true, feedRate: 60, target: [0, 1.3, 2.7] })
    run(logic, 12)
    logic.toggleGrip()
    expect(logic.holding).toBe(true)
    const part = logic.parts.find((candidate) => candidate.state === 'held')!
    const wrong = (part.color + 1) % 3
    const [x, y, z] = logic.slotPosition(wrong, 0)
    logic.params = { ...logic.params, target: [x, y + 0.2, z] }
    run(logic, 8)
    logic.toggleGrip()
    expect(logic.holding).toBe(false)
    expect(part.state).toBe('placed')
    expect(part.bin).toBe(wrong)
    expect(logic.missorted).toBe(1)
  })

  it('is reproducible from a seed', () => {
    const snapshot = (seed: number) => {
      const logic = make(seed)
      run(logic, 60)
      return [logic.placed, logic.joints, logic.parts.map((part) => [part.color, part.state, part.x])]
    }
    expect(snapshot(9)).toEqual(snapshot(9))
    expect(snapshot(9)).not.toEqual(snapshot(10))
  })
})
