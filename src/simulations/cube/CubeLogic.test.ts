import { describe, expect, it } from 'vitest'
import { Rng } from '../core/random'
import { STEP } from '../core/Simulation'
import { Cube, CubeLogic, PHASES, type Move } from './CubeLogic'

function scrambled(size: number, seed: number): Cube {
  const cube = new Cube(size)
  for (const move of cube.scramble(new Rng(seed), 20 + size * 15)) cube.apply(move)
  return cube
}

describe('Cube', () => {
  it('starts solved and is unsolved after a turn', () => {
    const cube = new Cube(3)
    expect(cube.isSolved()).toBe(true)
    cube.apply({ axis: 1, layer: 2, turns: 1 })
    expect(cube.isSolved()).toBe(false)
  })

  it('returns to where it started after four quarter turns of any layer', () => {
    for (const size of [2, 3, 4, 5]) {
      const cube = scrambled(size, 5)
      const before = cube.colors.slice()
      for (const axis of [0, 1, 2] as const) {
        for (let layer = 0; layer < size; layer++) {
          for (let i = 0; i < 4; i++) cube.apply({ axis, layer, turns: 1 })
          cube.apply({ axis, layer, turns: 2 })
          cube.apply({ axis, layer, turns: 2 })
          cube.apply({ axis, layer, turns: 3 })
          cube.apply({ axis, layer, turns: 1 })
        }
      }
      expect(Array.from(cube.colors)).toEqual(Array.from(before))
    }
  })

  it('keeps the same number of stickers of each colour', () => {
    const cube = scrambled(6, 9)
    const counts = new Array(6).fill(0)
    for (const colour of cube.colors) counts[colour]++
    expect(counts).toEqual(new Array(6).fill(36))
  })

  it('moves only the stickers in the turned layer', () => {
    const cube = new Cube(5)
    cube.apply({ axis: 0, layer: 1, turns: 1 })
    for (let i = 0; i < cube.count; i++) {
      if (cube.layerOf(i, 0) !== 1) expect(cube.colors[i]).toBe(cube.facelet(i).face)
    }
  })

  it('solves scrambled cubes of every size from 2 to 7', () => {
    for (let size = 2; size <= 7; size++) {
      for (let seed = 1; seed <= (size > 5 ? 4 : 12); seed++) {
        const cube = scrambled(size, seed * 31 + size)
        const solution = cube.solve()
        // solve() plans without touching the cube.
        expect(cube.isSolved()).toBe(false)
        for (const move of solution) cube.apply(move)
        expect(cube.isSolved()).toBe(true)
      }
    }
  }, 60000)

  it('solves cubes that are one turn, or one inner slice, from solved', () => {
    const cases: [number, Move][] = [
      [2, { axis: 0, layer: 0, turns: 1 }],
      [3, { axis: 1, layer: 1, turns: 1 }],
      [4, { axis: 2, layer: 1, turns: 3 }],
      [5, { axis: 0, layer: 2, turns: 2 }],
      [6, { axis: 1, layer: 4, turns: 1 }],
    ]
    for (const [size, move] of cases) {
      const cube = new Cube(size)
      cube.apply(move)
      for (const step of cube.solve()) cube.apply(step)
      expect(cube.isSolved()).toBe(true)
    }
  })

  it('has nothing to do on a solved cube', () => {
    expect(new Cube(4).solve()).toEqual([])
  })

  it('works through its phases in order and keeps a 3×3 under 260 turns', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const solution = scrambled(3, seed).solve()
      expect(solution.length).toBeLessThan(260)
      const order = solution.map((step) => PHASES.indexOf(step.phase))
      for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThanOrEqual(order[i - 1])
    }
  })

  it('never plans two turns of the same layer back to back', () => {
    const solution = scrambled(5, 3).solve()
    for (let i = 1; i < solution.length; i++) {
      expect(solution[i].axis === solution[i - 1].axis && solution[i].layer === solution[i - 1].layer).toBe(false)
    }
  })

  it('plans the same solution for the same scramble', () => {
    expect(scrambled(4, 8).solve()).toEqual(scrambled(4, 8).solve())
  })
})

describe('CubeLogic', () => {
  function run(logic: CubeLogic, seconds: number): void {
    for (let i = 0; i < seconds / STEP; i++) logic.step(STEP)
  }

  it('scrambles, then solves, one turn at a time', () => {
    const logic = new CubeLogic(3, new Rng(4))
    let solved = 0
    logic.onSolved = () => solved++
    logic.speed = 20
    logic.scramble()
    expect(logic.status).toBe('scrambling')
    run(logic, 5)
    expect(logic.status).toBe('idle')
    expect(logic.cube.isSolved()).toBe(false)
    logic.solve()
    const planned = logic.total
    expect(planned).toBeGreaterThan(0)
    run(logic, 2)
    expect(logic.status).toBe('solving')
    expect(logic.done).toBeGreaterThan(30)
    expect(logic.done).toBeLessThan(50)
    run(logic, 20)
    expect(logic.status).toBe('solved')
    expect(logic.done).toBe(planned)
    expect(logic.cube.isSolved()).toBe(true)
    expect(solved).toBe(1)
  })

  it('takes turns by hand only while the machine is not working', () => {
    const logic = new CubeLogic(4, new Rng(2))
    expect(logic.turn({ axis: 2, layer: 1, turns: 1 })).toBe(true)
    run(logic, 1)
    expect(logic.status).toBe('idle')
    expect(logic.cube.isSolved()).toBe(false)
    logic.solve()
    expect(logic.turn({ axis: 0, layer: 0, turns: 1 })).toBe(false)
    run(logic, 30)
    expect(logic.status).toBe('solved')
  })

  it('finishes sooner at a higher speed', () => {
    const time = (speed: number) => {
      const logic = new CubeLogic(3, new Rng(6))
      logic.speed = speed
      logic.scramble()
      run(logic, 10)
      logic.solve()
      run(logic, 120)
      expect(logic.status).toBe('solved')
      return logic.solveTime
    }
    expect(time(5) / time(20)).toBeCloseTo(4, 0)
  })
})
