import { describe, expect, it } from 'vitest'
import {
  PRESS_OBJECT_DEFS,
  PressLogic,
} from './PressLogic'

function runUntil(logic: PressLogic, condition: () => boolean, maxSeconds = 30, dt = 1 / 60): number {
  let elapsed = 0
  while (!condition() && elapsed < maxSeconds) {
    logic.step(dt)
    elapsed += dt
  }
  return elapsed
}

describe('PressLogic', () => {
  it('crushes a ductile object (soda can) and returns to idle', () => {
    const logic = new PressLogic(PRESS_OBJECT_DEFS.sodaCan, 100, 42)
    logic.start()
    expect(logic.state).toBe('descend')

    // Run until completion or idle
    runUntil(logic, () => logic.state === 'idle')
    expect(logic.state).toBe('idle')
    expect(logic.outcome?.head).toBe('CRUSHED')
    expect(logic.compression).toBeGreaterThan(0.7)
    expect(logic.pressExploded).toBe(false)
  })

  it('squishes an elastic object (rubber ball) and bounces back', () => {
    const logic = new PressLogic(PRESS_OBJECT_DEFS.rubberBall, 100, 42)
    logic.start()

    // Run until hold phase
    runUntil(logic, () => logic.state === 'hold')
    expect(logic.outcome?.head).toBe('BOING')
    expect(logic.compression).toBeCloseTo(0.62, 2)

    // Run until retract finishes
    runUntil(logic, () => logic.state === 'idle')
    expect(logic.state).toBe('idle')
    // Elastic bounce restores compression towards 0
    expect(logic.compression).toBeLessThan(0.05)
    expect(logic.pressExploded).toBe(false)
  })

  it('shatters a brittle object (glass cube)', () => {
    const logic = new PressLogic(PRESS_OBJECT_DEFS.glassCube, 100, 42)
    logic.start()

    runUntil(logic, () => logic.broken || logic.state === 'idle')
    expect(logic.broken).toBe(true)
    expect(logic.outcome?.head).toBe('SHATTERED')

    // Continues follow and retract
    runUntil(logic, () => logic.state === 'idle')
    expect(logic.state).toBe('idle')
    expect(logic.pressExploded).toBe(false)
  })

  it('rigid object (Nokia 3310) resists and destroys the press', () => {
    const logic = new PressLogic(PRESS_OBJECT_DEFS.nokia3310, 100, 42)
    logic.start()

    // Must reach strain
    runUntil(logic, () => logic.state === 'strain')
    expect(logic.state).toBe('strain')

    // Strain runs for STRAIN_TIME, then press explodes
    runUntil(logic, () => logic.state === 'failed')
    expect(logic.state).toBe('failed')
    expect(logic.pressExploded).toBe(true)
    expect(logic.statusHead).toBe('✖ PRESS DESTROYED')
    expect(logic.statusSub).toContain('Nokia 3310: 1 — Hydraulic press: 0')
    expect(logic.boltsPopped).toBe(2)
  })

  it('fails when capacity is below the brittle threshold (glass cube at 4 t)', () => {
    // Glass cube requires ~6 t
    const logic = new PressLogic(PRESS_OBJECT_DEFS.glassCube, 4, 42)
    logic.start()

    runUntil(logic, () => logic.state === 'strain')
    expect(logic.state).toBe('strain')

    runUntil(logic, () => logic.state === 'failed')
    expect(logic.state).toBe('failed')
    expect(logic.pressExploded).toBe(true)
    expect(logic.broken).toBe(false) // glass didn't shatter; press failed first
  })

  it('tungsten cube: lost at 100 t capacity, won at 350 t capacity', () => {
    // Underpowered: 100 t < 250 t yield -> press fails
    const weakPress = new PressLogic(PRESS_OBJECT_DEFS.tungstenCube, 100, 42)
    weakPress.start()
    runUntil(weakPress, () => weakPress.state === 'failed')
    expect(weakPress.state).toBe('failed')
    expect(weakPress.pressExploded).toBe(true)

    // Strong: 350 t > 250 t yield -> object yields and press crushes it
    const strongPress = new PressLogic(PRESS_OBJECT_DEFS.tungstenCube, 350, 42)
    strongPress.start()
    runUntil(strongPress, () => strongPress.state === 'idle')
    expect(strongPress.state).toBe('idle')
    expect(strongPress.outcome?.head).toBe('CRUSHED')
    expect(strongPress.cMax).toBeCloseTo(0.45, 2)
    expect(strongPress.compression).toBeCloseTo(0.42, 2)
  })

  it('guarantees same-seed reproducibility', () => {
    const a = new PressLogic(PRESS_OBJECT_DEFS.sodaCan, 100, 999)
    const b = new PressLogic(PRESS_OBJECT_DEFS.sodaCan, 100, 999)
    a.start()
    b.start()

    for (let i = 0; i < 300; i++) {
      a.step(1 / 60)
      b.step(1 / 60)
      expect(a.state).toBe(b.state)
      expect(a.ramY).toBeCloseTo(b.ramY, 8)
      expect(a.force).toBeCloseTo(b.force, 8)
      expect(a.pressure).toBeCloseTo(b.pressure, 8)
      expect(a.compression).toBeCloseTo(b.compression, 8)
    }
  })
})
