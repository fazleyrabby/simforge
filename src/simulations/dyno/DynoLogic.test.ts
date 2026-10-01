import { describe, expect, it } from 'vitest'
import { Rng } from '../core/random'
import { STEP } from '../core/Simulation'
import { DynoLogic, engineTorque, generateCycle, generateVehicle, type DynoParams } from './DynoLogic'

const base: DynoParams = { mode: 'manual', throttle: 0.5, grade: 0, grip: 1, wind: 0 }

function make(seed: number, params: Partial<DynoParams> = {}): DynoLogic {
  const rng = new Rng(seed)
  return new DynoLogic(generateVehicle(rng, [0xff0000]), generateCycle(rng), { ...base, ...params })
}

function run(logic: DynoLogic, seconds: number, each?: () => void): void {
  for (let i = 0; i < seconds / STEP; i++) {
    logic.step(STEP)
    each?.()
  }
}

describe('DynoLogic', () => {
  it('settles where drive force balances road load', () => {
    const logic = make(11)
    run(logic, 400)
    expect(logic.rollerSpeed).toBeGreaterThan(10)
    expect(Math.abs(logic.acceleration)).toBeLessThan(0.01)
    // Power at the rollers equals road load × speed at steady state.
    const loadPower = logic.roadLoad(logic.rollerSpeed) * logic.rollerSpeed
    expect(Math.abs(logic.wheelPower - loadPower) / loadPower).toBeLessThan(0.01)
  })

  it('ties engine speed to wheel speed through the gearbox', () => {
    const logic = make(11)
    run(logic, 60)
    const { vehicle } = logic
    const ratio = vehicle.gears[logic.gear] * vehicle.finalDrive
    const expected = (logic.wheelSpeed / vehicle.wheelRadius) * (60 / (2 * Math.PI)) * ratio
    expect(logic.rpm).toBeCloseTo(expected, 0)
    expect(logic.rpm).toBeLessThanOrEqual(vehicle.redline * 1.02)
  })

  it('goes slower uphill and into a headwind', () => {
    const flat = make(11)
    const hill = make(11, { grade: 8 })
    const wind = make(11, { wind: 25 })
    for (const logic of [flat, hill, wind]) run(logic, 400)
    expect(hill.rollerSpeed).toBeLessThan(flat.rollerSpeed - 1)
    expect(wind.rollerSpeed).toBeLessThan(flat.rollerSpeed - 1)
  })

  it('spins the wheels when torque exceeds roller grip', () => {
    const grippy = make(11, { throttle: 1 })
    const slippery = make(11, { throttle: 1, grip: 0.15 })
    let peakSlip = 0
    run(slippery, 4, () => (peakSlip = Math.max(peakSlip, slippery.slip)))
    run(grippy, 4)
    expect(peakSlip).toBeGreaterThan(0.3)
    expect(slippery.rollerSpeed).toBeLessThan(grippy.rollerSpeed * 0.6)
    // Roller acceleration can never exceed what friction can transmit.
    expect(slippery.rollerSpeed / 4).toBeLessThanOrEqual(0.15 * 9.81 * 0.55 + 1e-6)
  })

  it('tracks the drive cycle', () => {
    const logic = make(11, { mode: 'cycle' })
    let error = 0
    let samples = 0
    run(logic, 90, () => {
      error += Math.abs(logic.targetSpeed() - logic.rollerSpeed)
      samples++
    })
    expect(error / samples).toBeLessThan(1.5)
  })

  it('reports peak power from a power run below the engine maximum', () => {
    const logic = make(11)
    let result = { peakPower: 0, peakRpm: 0 }
    logic.onPowerRunEnd = (r) => (result = r)
    logic.startPowerRun()
    run(logic, 20)
    const { vehicle } = logic
    let enginePeak = 0
    for (let rpm = 1000; rpm <= vehicle.redline; rpm += 50) {
      enginePeak = Math.max(enginePeak, (engineTorque(vehicle, rpm) * rpm * 2 * Math.PI) / 60)
    }
    expect(logic.powerRun).toBe(false)
    expect(result.peakPower).toBeGreaterThan(enginePeak * 0.7)
    expect(result.peakPower).toBeLessThan(enginePeak)
  })

  it('is reproducible from a seed', () => {
    const snapshot = (seed: number) => {
      const logic = make(seed, { mode: 'cycle' })
      run(logic, 45)
      return [logic.vehicle, logic.rollerSpeed, logic.gear, logic.distance]
    }
    expect(snapshot(5)).toEqual(snapshot(5))
    expect(snapshot(5)).not.toEqual(snapshot(6))
  })
})
