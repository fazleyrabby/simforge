import { describe, expect, it } from 'vitest'
import { STEP } from '../core/Simulation'
import { COMPRESSION_RATIO, CRANK_RADIUS, EngineLogic, REV_LIMIT, cylinderVolume, pistonDrop, type EngineParams } from './EngineLogic'

function make(count = 4, overrides: Partial<EngineParams> = {}): EngineLogic {
  return new EngineLogic(count, { throttle: 0, load: 0, advance: 22, ignition: true, ...overrides })
}

function run(engine: EngineLogic, seconds: number): EngineLogic {
  for (let i = 0; i < seconds / STEP; i++) engine.step(STEP)
  return engine
}

function started(count = 4, overrides: Partial<EngineParams> = {}, seconds = 8): EngineLogic {
  const engine = make(count, overrides)
  engine.start()
  return run(engine, seconds)
}

const peak = (engine: EngineLogic) => Math.max(...engine.tracePressure)

describe('EngineLogic', () => {
  it('moves the piston one stroke between dead centres and squeezes by the compression ratio', () => {
    expect(pistonDrop(0)).toBeCloseTo(0, 9)
    expect(pistonDrop(180)).toBeCloseTo(2 * CRANK_RADIUS, 9)
    expect(pistonDrop(90)).toBeGreaterThan(CRANK_RADIUS)
    expect(cylinderVolume(180) / cylinderVolume(0)).toBeCloseTo(COMPRESSION_RATIO, 6)
  })

  it('spaces the firing evenly through the cycle', () => {
    for (const count of [1, 2, 3, 4, 6]) {
      const offsets = make(count).cylinders.map((cylinder) => cylinder.offset).sort((a, b) => a - b)
      offsets.forEach((offset, i) => expect(offset).toBeCloseTo((i * 720) / count, 9))
    }
  })

  it('does nothing until the starter is used', () => {
    const engine = run(make(), 2)
    expect(engine.status).toBe('off')
    expect(engine.speed).toBe(0)
  })

  it('starts and settles at idle with the throttle closed, for every layout', () => {
    for (const count of [1, 2, 3, 4, 6]) {
      const engine = started(count)
      expect(engine.status).toBe('running')
      expect(engine.rpm).toBeGreaterThan(700)
      expect(engine.rpm).toBeLessThan(1000)
    }
  })

  it('runs faster with more throttle and slower with more load', () => {
    const speed = (throttle: number, load: number) => started(4, { throttle, load }).rpm
    expect(speed(0.5, 100)).toBeGreaterThan(speed(0.25, 100) + 500)
    expect(speed(0.25, 100)).toBeGreaterThan(speed(0.1, 100) + 500)
    expect(speed(0.5, 160)).toBeLessThan(speed(0.5, 100) - 500)
  })

  it('settles where its torque matches the brake', () => {
    const engine = started(4, { throttle: 0.5, load: 100 }, 12)
    const brake = 100 * (0.5 + (0.5 * engine.rpm) / 3000)
    expect(Math.abs(engine.torque - brake) / brake).toBeLessThan(0.06)
    expect(engine.power).toBeGreaterThan(20000)
    expect(engine.efficiency).toBeGreaterThan(0.2)
    expect(engine.efficiency).toBeLessThan(0.4)
  })

  it('makes most power with the spark a little before top dead centre', () => {
    const power = (advance: number) => started(4, { throttle: 0.5, load: 100, advance }).power
    const best = power(22)
    expect(best).toBeGreaterThan(power(0) * 1.1)
    expect(best).toBeGreaterThan(power(60) * 1.1)
    expect(best).toBeGreaterThan(power(-10) * 1.3)
  })

  it('burns to a far higher pressure than compression alone reaches', () => {
    const firing = started(4, { throttle: 1, load: 160 })
    expect(peak(firing)).toBeGreaterThan(45e5)
    // Switched off, it coasts on compression only: never above atmospheric squeezed adiabatically.
    firing.params.ignition = false
    firing.params.load = 0
    run(firing, 0.5)
    expect(firing.speed).toBeGreaterThan(0)
    expect(peak(firing)).toBeLessThan(101325 * Math.pow(COMPRESSION_RATIO, 1.33) * 1.02)
    expect(peak(firing)).toBeGreaterThan(3e5)
  })

  it('holds at the rev limiter with the throttle open and nothing to drive', () => {
    const engine = started(4, { throttle: 1 })
    expect(engine.rpm).toBeGreaterThan(REV_LIMIT - 300)
    expect(engine.rpm).toBeLessThan(REV_LIMIT + 150)
  })

  it('stalls when the brake asks for more than idle can give, and restarts once it is eased', () => {
    const engine = started(4, { load: 250 })
    expect(engine.status).toBe('stalled')
    expect(engine.speed).toBe(0)
    engine.params.load = 20
    engine.start()
    run(engine, 6)
    expect(engine.status).toBe('running')
  })

  it('coasts to a stop when the ignition is switched off', () => {
    const engine = started(4, { throttle: 0.3, load: 40 })
    engine.params.ignition = false
    run(engine, 15)
    expect(engine.status).toBe('off')
    expect(engine.speed).toBe(0)
    expect(engine.fuelRate).toBeLessThan(1e-6)
  })

  it('turns more smoothly with more cylinders', () => {
    const ripple = (count: number) => started(count).ripple
    expect(ripple(1)).toBeGreaterThan(ripple(4))
    expect(ripple(4)).toBeGreaterThan(ripple(6))
  })

  it('gives the same run twice', () => {
    const a = started(3, { throttle: 0.4, load: 60 })
    const b = started(3, { throttle: 0.4, load: 60 })
    expect(a.rpm).toBe(b.rpm)
    expect(a.angle).toBe(b.angle)
  })
})
