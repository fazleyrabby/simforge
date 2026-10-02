import { describe, expect, it } from 'vitest'
import { Rng } from '../core/random'
import { STEP } from '../core/Simulation'
import { EAST, NORTH, SOUTH, WEST, WarehouseLogic, findPath, generateLayout, neighbours, type Layout } from './WarehouseLogic'

function make(seed: number, robots: number, orderRate = 60, speed = 3) {
  const rng = new Rng(seed)
  const layout = generateLayout(rng, 8, 8, 3, 16)
  return new WarehouseLogic(rng, layout, robots, { orderRate, speed })
}

function run(logic: WarehouseLogic, seconds: number, each?: () => void): void {
  for (let i = 0; i < seconds / STEP; i++) {
    logic.step(STEP)
    each?.()
  }
}

/** Cells reachable from a start by legal moves. */
function reach(layout: Layout, start: number): Set<number> {
  const seen = new Set([start])
  const stack = [start]
  const around: number[] = []
  while (stack.length > 0) {
    for (const next of neighbours(layout, stack.pop()!, around)) {
      if (!seen.has(next)) {
        seen.add(next)
        stack.push(next)
      }
    }
  }
  return seen
}

/** Shortest legal distance by plain breadth-first search, as an independent check on A*. */
function bfs(layout: Layout, from: number, to: number): number {
  const distance = new Map([[from, 0]])
  const queue = [from]
  const around: number[] = []
  while (queue.length > 0) {
    const cell = queue.shift()!
    if (cell === to) return distance.get(cell)!
    for (const next of neighbours(layout, cell, around)) {
      if (next !== to && layout.kinds[next] !== 'floor') continue
      if (!distance.has(next)) {
        distance.set(next, distance.get(cell)! + 1)
        queue.push(next)
      }
    }
  }
  return -1
}

describe('generateLayout', () => {
  it('lets every floor cell, dock and station reach every other', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const layout = generateLayout(new Rng(seed), 8, 8, 3, 16)
      const open = layout.kinds.map((kind, cell) => (kind === 'shelf' || kind === 'wall' ? -1 : cell)).filter((cell) => cell >= 0)
      for (const start of [layout.docks[0], layout.stations[0], open[Math.floor(open.length / 2)]]) {
        expect(reach(layout, start).size).toBe(open.length)
      }
      // Reaching out from one cell and being reached by all are both needed; check the reverse from every cell.
      for (const cell of open) expect(reach(layout, cell).has(layout.docks[0])).toBe(true)
    }
  })

  it('gives each shelf a pick face in an aisle beside it', () => {
    const layout = generateLayout(new Rng(7), 8, 8, 3, 16)
    expect(layout.shelves.length).toBeGreaterThan(60)
    for (const shelf of layout.shelves) {
      const face = layout.pickFace[shelf]
      expect(layout.kinds[face]).toBe('floor')
      expect(Math.abs((face % layout.width) - (shelf % layout.width))).toBe(1)
      expect(Math.floor(face / layout.width)).toBe(Math.floor(shelf / layout.width))
    }
    expect(layout.docks).toHaveLength(16)
    expect(layout.stations).toHaveLength(3)
  })

  it('keeps aisles one-way: no two neighbouring floor cells can drive into each other', () => {
    const layout = generateLayout(new Rng(9), 8, 8, 3, 16)
    const opposite: Record<number, number> = { [NORTH]: SOUTH, [SOUTH]: NORTH, [EAST]: WEST, [WEST]: EAST }
    const offsets: Record<number, number> = { [NORTH]: -layout.width, [SOUTH]: layout.width, [EAST]: 1, [WEST]: -1 }
    layout.kinds.forEach((kind, cell) => {
      if (kind !== 'floor') return
      for (const bit of [NORTH, EAST, SOUTH, WEST]) {
        if (!(layout.exits[cell] & bit)) continue
        const next = cell + offsets[bit]
        if (layout.kinds[next] === 'floor') expect(layout.exits[next] & opposite[bit]).toBe(0)
      }
    })
  })
})

describe('findPath', () => {
  it('returns a shortest legal route', () => {
    const layout = generateLayout(new Rng(3), 8, 8, 3, 16)
    const around: number[] = []
    for (const shelf of layout.shelves.filter((_, i) => i % 7 === 0)) {
      const from = layout.docks[shelf % layout.docks.length]
      const to = layout.pickFace[shelf]
      const path = findPath(layout, from, to)!
      expect(path.length).toBe(bfs(layout, from, to))
      let cell = from
      for (const next of path) {
        expect(neighbours(layout, cell, around)).toContain(next)
        cell = next
      }
      expect(cell).toBe(to)
    }
  })
})

describe('WarehouseLogic', () => {
  it('never lets two robots hold the same cell', () => {
    const logic = make(5, 16, 120)
    run(logic, 120, () => {
      const held = new Set<number>()
      for (const robot of logic.robots) {
        for (const cell of [robot.cell, robot.next]) {
          if (cell < 0) continue
          expect(held.has(cell)).toBe(false)
          held.add(cell)
          expect(logic.reserved[cell]).toBe(robot.id)
        }
      }
    })
  })

  it('accounts for every order', () => {
    const logic = make(8, 8, 90)
    run(logic, 90)
    expect(logic.completed).toBeGreaterThan(20)
    expect(logic.created).toBe(logic.completed + logic.openOrders)
  })

  it('keeps delivering under heavy load without gridlock', () => {
    const logic = make(11, 16, 240)
    let last = 0
    for (let window = 0; window < 8; window++) {
      run(logic, 30)
      expect(logic.completed).toBeGreaterThan(last)
      last = logic.completed
    }
  })

  it('delivers more with a bigger fleet', () => {
    const small = make(4, 2, 240)
    const large = make(4, 10, 240)
    run(small, 120)
    run(large, 120)
    expect(large.completed).toBeGreaterThan(small.completed * 2)
  })

  it('serves a rush order before the rest of the queue', () => {
    const logic = make(6, 1, 0)
    logic.surge(5)
    const rush = logic.rush(logic.layout.shelves[10])!
    logic.step(STEP)
    expect(logic.robots[0].order).toBe(rush)
  })

  it('sends low robots to charge and brings them back', () => {
    const logic = make(2, 4, 200)
    let charged = false
    run(logic, 600, () => {
      if (logic.robots.some((robot) => robot.state === 'charging')) charged = true
      for (const robot of logic.robots) expect(robot.battery).toBeGreaterThan(0)
    })
    expect(charged).toBe(true)
    expect(logic.completed).toBeGreaterThan(80)
  })

  it('is reproducible from a seed', () => {
    const snapshot = (seed: number) => {
      const logic = make(seed, 8, 90)
      run(logic, 60)
      return [logic.completed, logic.created, logic.robots.map((robot) => [robot.cell, robot.state, robot.distance])]
    }
    expect(snapshot(21)).toEqual(snapshot(21))
    expect(snapshot(21)).not.toEqual(snapshot(22))
  })
})
