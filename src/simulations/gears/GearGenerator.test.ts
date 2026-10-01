import { describe, expect, it } from 'vitest'
import { Rng } from '../core/random'
import { gearAngle, gearOmega, generateGearTrain, MESH_EFFICIENCY, systemEfficiency } from './GearGenerator'

describe('generateGearTrain', () => {
  const train = generateGearTrain(new Rng(48291), 12, 1)

  it('builds a tree rooted at one driver', () => {
    expect(train.gears.length).toBe(12)
    expect(train.gears.filter((gear) => gear.parent === -1)).toHaveLength(1)
    for (const gear of train.gears.slice(1)) expect(gear.parent).toBeLessThan(gear.id)
  })

  it('places meshed gears exactly r1 + r2 apart with a shared module', () => {
    for (const gear of train.gears) {
      expect(gear.radius).toBeCloseTo((train.module * gear.teeth) / 2)
      if (gear.parent < 0) continue
      const parent = train.gears[gear.parent]
      expect(Math.hypot(gear.x - parent.x, gear.z - parent.z)).toBeCloseTo(gear.radius + parent.radius)
    }
  })

  it('never overlaps gears that are not meshed', () => {
    for (const a of train.gears) {
      for (const b of train.gears) {
        if (a.id >= b.id || b.parent === a.id || a.parent === b.id) continue
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(a.radius + b.radius + train.module * 2)
      }
    }
  })

  it('counter-rotates neighbours at the tooth-count ratio', () => {
    const driverOmega = 3
    for (const gear of train.gears) {
      if (gear.parent < 0) continue
      const parent = train.gears[gear.parent]
      const omega = gearOmega(gear, driverOmega)
      const parentOmega = gearOmega(parent, driverOmega)
      expect(Math.sign(omega)).toBe(-Math.sign(parentOmega))
      // Equal tooth-passing rate at the mesh point.
      expect(omega * gear.teeth).toBeCloseTo(-parentOmega * parent.teeth)
    }
  })

  it('keeps teeth interlocked at every driver angle', () => {
    const TAU = Math.PI * 2
    for (const driverAngle of [0, 0.37, 2.1, 9.9]) {
      for (const gear of train.gears) {
        if (gear.parent < 0) continue
        const parent = train.gears[gear.parent]
        const direction = Math.atan2(-(gear.z - parent.z), gear.x - parent.x)
        const u = ((direction - gearAngle(parent, driverAngle)) * parent.teeth) / TAU
        const v = ((direction + Math.PI - gearAngle(gear, driverAngle)) * gear.teeth) / TAU
        const sum = u + v
        // A tooth on one gear always faces a gap on the other.
        expect(Math.abs(sum - Math.round(sum))).toBeCloseTo(0.5)
      }
    }
  })

  it('loses efficiency per mesh along the deepest chain', () => {
    expect(systemEfficiency(train)).toBeCloseTo(MESH_EFFICIENCY ** train.maxDepth)
  })

  it('is reproducible from a seed', () => {
    expect(generateGearTrain(new Rng(7), 10, 1)).toEqual(generateGearTrain(new Rng(7), 10, 1))
    expect(generateGearTrain(new Rng(7), 10, 1)).not.toEqual(generateGearTrain(new Rng(8), 10, 1))
  })
})
