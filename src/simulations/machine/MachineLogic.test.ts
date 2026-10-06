import { describe, expect, it } from 'vitest'
import { Rng } from '../core/random'
import { STEP } from '../core/Simulation'
import { MachineLogic, STAGES, type MachineParams } from './MachineLogic'

const base: MachineParams = { marbleMass: 1, rampAngle: 11, spacing: 0.55, ballast: 1, gravity: 10 }

function make(seed = 1, overrides: Partial<MachineParams> = {}): MachineLogic {
  return new MachineLogic(new Rng(seed), { ...base, ...overrides })
}

/** Releases the marble and runs until the machine finishes or stalls. */
function play(machine: MachineLogic, each?: () => void): MachineLogic {
  machine.release()
  for (let i = 0; i < 60 * 45 && machine.status === 'running'; i++) {
    machine.step(STEP)
    each?.()
  }
  return machine
}

describe('MachineLogic', () => {
  it('runs the whole chain, in order, for every seed', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const machine = play(make(seed))
      expect(machine.status).toBe('complete')
      expect(machine.stage).toBe(STAGES.length)
      for (let i = 1; i < STAGES.length; i++) expect(machine.stageTimes[i]).toBeGreaterThanOrEqual(machine.stageTimes[i - 1])
    }
  }, 60000)

  it('sits still until the latch is pulled', () => {
    const machine = make(3)
    const marble = machine.pieces.find((piece) => piece.role === 'marble')!.body
    const start = { ...marble.getPosition() }
    for (let i = 0; i < 300; i++) machine.step(STEP)
    expect(Math.hypot(marble.getPosition().x - start.x, marble.getPosition().y - start.y)).toBeLessThan(0.05)
    expect(machine.status).toBe('ready')
    expect(machine.gateLift).toBeLessThan(0.01)
  })

  it('keeps the gate shut until the bucket is loaded', () => {
    const machine = make(2)
    play(machine, () => {
      if (machine.stage < 4) expect(machine.gateLift).toBeLessThan(0.02)
    })
    expect(machine.gateLift).toBeGreaterThan(0.7)
  })

  it('ends with the gate raised as far as the bucket dropped', () => {
    const machine = make(2)
    const bucketStart = machine.bucket.getPosition().y
    const gateStart = machine.gate.getPosition().y
    play(machine)
    // One rope over two pulleys. Mid-run the gate can overshoot and leave the rope slack,
    // so the lengths are compared once everything has settled.
    for (let i = 0; i < 240; i++) machine.step(STEP)
    const dropped = bucketStart - machine.bucket.getPosition().y
    expect(dropped).toBeGreaterThan(1.5)
    expect(Math.abs(dropped - (machine.gate.getPosition().y - gateStart))).toBeLessThan(0.05)
  })

  it('keeps the striker down until the second bucket is loaded, then hoists it into the bell', () => {
    const machine = make(3)
    play(machine, () => {
      if (machine.stage < 10) expect(machine.strikerLift).toBeLessThan(0.02)
    })
    expect(machine.status).toBe('complete')
    // The hoist is geared: the striker travels further than its bucket drops.
    expect(machine.strikerLift).toBeGreaterThan(1.8)
    expect(machine.stageTimes[9]).toBeGreaterThan(machine.stageTimes[6])
  })

  it('stalls at the ramp when the slope is too shallow for the marble to arrive', () => {
    const machine = play(make(1, { rampAngle: 2 }))
    expect(machine.status).toBe('stalled')
    expect(machine.stage).toBe(1)
  })

  it('stalls at the ramp when the marble is too light to topple a domino', () => {
    const machine = play(make(1, { marbleMass: 0.02 }))
    expect(machine.status).toBe('stalled')
    expect(machine.stage).toBe(1)
  })

  it('stalls in the dominoes when they stand too far apart to reach each other', () => {
    const machine = play(make(1, { spacing: 1.2 }))
    expect(machine.status).toBe('stalled')
    expect(machine.stage).toBe(2)
  })

  it('stalls at the pulley when the gate outweighs the loaded bucket', () => {
    const machine = play(make(1, { ballast: 3 }))
    expect(machine.status).toBe('stalled')
    expect(machine.stage).toBe(4)
    // The bucket sags a little under the extra dominoes that follow, but not enough to free the ball.
    expect(machine.gateLift).toBeLessThan(0.3)
  })

  it('lets a piece be picked up and carried', () => {
    const machine = make(1)
    const marble = machine.pieces.find((piece) => piece.role === 'marble')!.body
    const { x, y } = marble.getPosition()
    expect(machine.grab(-8, 2)).toBe(false)
    expect(machine.grab(x, y)).toBe(true)
    for (let i = 0; i < 120; i++) {
      machine.drag(x + 1.5, y + 1.5)
      machine.step(STEP)
    }
    expect(marble.getPosition().x).toBeGreaterThan(x + 1)
    expect(marble.getPosition().y).toBeGreaterThan(y + 1)
    machine.drop()
  })

  it('plays out identically from the same seed', () => {
    const times = (seed: number) => play(make(seed)).stageTimes
    expect(times(7)).toEqual(times(7))
  })
})
