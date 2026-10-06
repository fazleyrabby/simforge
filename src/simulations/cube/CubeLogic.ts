import type { Rng } from '../core/random'

/**
 * A twisty cube of any size, and a solver for it, independent of rendering.
 *
 * Stickers ("facelets") are indexed face by face. Faces are numbered
 * 0 +x, 1 −x, 2 +y, 3 −y, 4 +z, 5 −z, and a solved cube has colour = face.
 * A move turns one layer a quarter turn or more about an axis.
 */

export interface Move {
  axis: 0 | 1 | 2
  /** Layer along the axis, 0 at the negative side up to size − 1. */
  layer: number
  /** Quarter turns, right-handed about the positive axis: 1, 2 or 3. */
  turns: 1 | 2 | 3
}

export type Phase = 'parity' | 'centres' | 'edges' | 'corners'
export const PHASES: Phase[] = ['parity', 'centres', 'edges', 'corners']

export interface SolveStep extends Move {
  phase: Phase
}

type Kind = 'corner' | 'edge' | 'centre'

/** A set of stickers that the moves can carry onto one another, with a three-cycle that reaches all of it. */
interface Orbit {
  kind: Kind
  facelets: number[]
  /** Position of each facelet within `facelets`, or −1. */
  local: Int16Array
  /** A move sequence that cycles three pieces of this orbit and nothing else. */
  macro: number[]
  /** The three facelets it cycles: the sticker at [0] goes to [1], [1] to [2], [2] to [0]. */
  base: [number, number, number]
  /** Breadth-first tree over triples of facelets, rooted at `base`. Built on first use. */
  parent: Int32Array | null
  via: Uint8Array | null
}

/** Everything about a cube of one size that does not depend on its state. */
class Geometry {
  readonly count: number
  /** Position of each facelet, in half-cells: the coordinate along its face normal is ±size. */
  readonly position: Int8Array
  readonly face: Uint8Array
  /** Which piece each facelet is on, and the facelets of each piece. */
  readonly cubie: Int16Array
  readonly cubies: number[][] = []
  /** perms[move][i] is where the sticker at facelet i ends up. */
  readonly perms: Int16Array[] = []
  readonly orbits: Orbit[] = []
  private index = new Map<number, number>()

  constructor(readonly size: number) {
    const n = size
    this.count = 6 * n * n
    this.position = new Int8Array(this.count * 3)
    this.face = new Uint8Array(this.count)
    this.cubie = new Int16Array(this.count)

    let i = 0
    const cubieOf = new Map<number, number>()
    for (let face = 0; face < 6; face++) {
      const axis = face >> 1
      const sign = face & 1 ? -1 : 1
      for (let u = 0; u < n; u++) {
        for (let v = 0; v < n; v++) {
          const p = [0, 0, 0]
          p[axis] = sign * n
          p[(axis + 1) % 3] = 2 * u - (n - 1)
          p[(axis + 2) % 3] = 2 * v - (n - 1)
          this.position.set(p, i * 3)
          this.face[i] = face
          this.index.set(this.key(p[0], p[1], p[2]), i)
          // The piece a sticker sits on is its cell, one half-cell in from the surface.
          p[axis] = sign * (n - 1)
          const cell = this.key(p[0], p[1], p[2])
          let id = cubieOf.get(cell)
          if (id === undefined) {
            id = this.cubies.length
            cubieOf.set(cell, id)
            this.cubies.push([])
          }
          this.cubie[i] = id
          this.cubies[id].push(i)
          i++
        }
      }
    }

    for (let axis = 0; axis < 3; axis++) {
      for (let layer = 0; layer < n; layer++) {
        const quarter = this.quarterTurn(axis, layer)
        const half = compose(quarter, quarter)
        this.perms.push(quarter, half, compose(half, quarter))
      }
    }
    this.findOrbits()
    this.findMacros()
  }

  moveId(axis: number, layer: number, turns: number): number {
    return (axis * this.size + layer) * 3 + (turns - 1)
  }

  toMove(id: number): Move {
    const slot = Math.floor(id / 3)
    return { axis: Math.floor(slot / this.size) as 0 | 1 | 2, layer: slot % this.size, turns: ((id % 3) + 1) as 1 | 2 | 3 }
  }

  inverse(id: number): number {
    return id - (id % 3) + (2 - (id % 3))
  }

  /** Layer a facelet belongs to along an axis. */
  layerOf(facelet: number, axis: number): number {
    const value = this.position[facelet * 3 + axis]
    if (Math.abs(value) === this.size) return value < 0 ? 0 : this.size - 1
    return (value + this.size - 1) / 2
  }

  private key(x: number, y: number, z: number): number {
    return ((x + 16) * 64 + (y + 16)) * 64 + (z + 16)
  }

  private quarterTurn(axis: number, layer: number): Int16Array {
    const perm = new Int16Array(this.count)
    for (let i = 0; i < this.count; i++) {
      if (this.layerOf(i, axis) !== layer) {
        perm[i] = i
        continue
      }
      const x = this.position[i * 3]
      const y = this.position[i * 3 + 1]
      const z = this.position[i * 3 + 2]
      const to = axis === 0 ? this.key(x, -z, y) : axis === 1 ? this.key(z, y, -x) : this.key(-y, x, z)
      perm[i] = this.index.get(to)!
    }
    return perm
  }

  /** Groups facelets into orbits, keeping one orbit per set of pieces. */
  private findOrbits(): void {
    const root = new Int16Array(this.count).map((_, i) => i)
    const find = (i: number): number => {
      while (root[i] !== i) i = root[i] = root[root[i]]
      return i
    }
    for (let move = 0; move < this.perms.length; move += 3) {
      const perm = this.perms[move]
      for (let i = 0; i < this.count; i++) root[find(i)] = find(perm[i])
    }
    const groups = new Map<number, number[]>()
    for (let i = 0; i < this.count; i++) {
      const group = groups.get(find(i))
      if (group) group.push(i)
      else groups.set(find(i), [i])
    }
    const covered = new Set<number>()
    for (const facelets of groups.values()) {
      // The six middle centres never move relative to one another: they are the frame, not a puzzle.
      if (facelets.length < 24) continue
      // An off-centre edge piece has one sticker in each of two orbits; solving one solves both.
      if (covered.has(this.cubie[facelets[0]])) continue
      for (const facelet of facelets) covered.add(this.cubie[facelet])
      const stickers = this.cubies[this.cubie[facelets[0]]].length
      const local = new Int16Array(this.count).fill(-1)
      facelets.forEach((facelet, at) => (local[facelet] = at))
      this.orbits.push({ kind: stickers === 3 ? 'corner' : stickers === 2 ? 'edge' : 'centre', facelets, local, macro: [], base: [0, 0, 0], parent: null, via: null })
    }
  }

  /**
   * Finds a pure three-cycle for every orbit. Each is a commutator A B A′ B′
   * where the pieces A moves and the pieces B moves overlap in exactly one
   * place, which is what makes everything else cancel.
   */
  private findMacros(): void {
    const n = this.size
    const last = n - 1
    const candidates: number[][] = []
    const quarter = [1, 3]
    // Corners: slip one corner out of the top layer and back, around a top turn.
    for (const a of quarter) {
      for (const b of quarter) {
        for (const c of quarter) {
          const insert = [this.moveId(0, last, a), this.moveId(1, 0, b), this.moveId(0, last, 4 - a)]
          const turn = this.moveId(1, last, c)
          candidates.push([...insert, turn, ...insert.map((_, k) => this.inverse(insert[2 - k])), this.inverse(turn)])
        }
      }
    }
    // Edges and centres: a slice, against another layer swung a quarter turn round by the top.
    for (let i = 1; i < last; i++) {
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        for (const a of quarter) {
          for (const b of quarter) {
            for (const c of quarter) {
              const slice = this.moveId(0, i, a)
              const swung = [this.moveId(1, last, b), this.moveId(0, j, c), this.moveId(1, last, 4 - b)]
              candidates.push([slice, ...swung, this.inverse(slice), ...swung.map((_, k) => this.inverse(swung[2 - k]))])
            }
          }
        }
      }
    }

    let missing = this.orbits.length
    for (const sequence of candidates) {
      if (missing === 0) break
      let perm = this.perms[sequence[0]]
      for (let k = 1; k < sequence.length; k++) perm = compose(perm, this.perms[sequence[k]])
      const moved = new Set<number>()
      for (let i = 0; i < this.count; i++) if (perm[i] !== i) moved.add(this.cubie[i])
      if (moved.size !== 3) continue
      for (const orbit of this.orbits) {
        if (orbit.macro.length > 0) continue
        const first = orbit.facelets.find((facelet) => perm[facelet] !== facelet)
        if (first === undefined) continue
        const second = perm[first]
        const third = perm[second]
        if (perm[third] !== first) continue
        orbit.macro = sequence
        orbit.base = [first, second, third]
        missing--
      }
    }
    if (missing > 0) throw new Error(`No three-cycle found for ${missing} orbit(s) of a size ${n} cube`)
  }

  /** Moves that carry the stickers at three facelets onto the orbit's base cycle. */
  setup(orbit: Orbit, a: number, b: number, c: number): number[] {
    const size = orbit.facelets.length
    if (!orbit.parent) {
      const parent = (orbit.parent = new Int32Array(size * size * size).fill(-1))
      const via = (orbit.via = new Uint8Array(size * size * size))
      const start = (orbit.local[orbit.base[0]] * size + orbit.local[orbit.base[1]]) * size + orbit.local[orbit.base[2]]
      parent[start] = start
      const queue = new Int32Array(size * size * size)
      let head = 0
      let tail = 0
      queue[tail++] = start
      while (head < tail) {
        const state = queue[head++]
        const x = orbit.facelets[Math.floor(state / (size * size))]
        const y = orbit.facelets[Math.floor(state / size) % size]
        const z = orbit.facelets[state % size]
        for (let move = 0; move < this.perms.length; move++) {
          const perm = this.perms[move]
          if (perm[x] === x && perm[y] === y && perm[z] === z) continue
          const next = (orbit.local[perm[x]] * size + orbit.local[perm[y]]) * size + orbit.local[perm[z]]
          if (parent[next] !== -1) continue
          parent[next] = state
          via[next] = move
          queue[tail++] = next
        }
      }
    }
    let state = (orbit.local[a] * size + orbit.local[b]) * size + orbit.local[c]
    if (orbit.parent[state] === -1) throw new Error('Unreachable arrangement of three pieces')
    const moves: number[] = []
    while (orbit.parent[state] !== state) {
      moves.push(this.inverse(orbit.via![state]))
      state = orbit.parent[state]
    }
    return moves
  }
}

function compose(first: Int16Array, second: Int16Array): Int16Array {
  const result = new Int16Array(first.length)
  for (let i = 0; i < first.length; i++) result[i] = second[first[i]]
  return result
}

const geometries = new Map<number, Geometry>()
function geometryFor(size: number): Geometry {
  let geometry = geometries.get(size)
  if (!geometry) {
    geometry = new Geometry(size)
    geometries.set(size, geometry)
  }
  return geometry
}

/** The state of a cube: one colour per facelet. */
export class Cube {
  readonly colors: Uint8Array
  private geometry: Geometry
  private scratch: Uint8Array

  constructor(readonly size: number) {
    this.geometry = geometryFor(size)
    this.colors = new Uint8Array(this.geometry.count)
    this.scratch = new Uint8Array(this.geometry.count)
    this.reset()
  }

  get count(): number {
    return this.geometry.count
  }

  reset(): void {
    this.colors.set(this.geometry.face)
  }

  clone(): Cube {
    const copy = new Cube(this.size)
    copy.colors.set(this.colors)
    return copy
  }

  apply(move: Move): void {
    this.applyId(this.geometry.moveId(move.axis, move.layer, move.turns))
  }

  /** Every face a single colour, whichever way round the cube is held. */
  isSolved(): boolean {
    const area = this.size * this.size
    for (let i = 0; i < this.count; i++) if (this.colors[i] !== this.colors[i - (i % area)]) return false
    return true
  }

  /** Position of a facelet in half-cells, and its face. */
  facelet(i: number): { x: number; y: number; z: number; face: number } {
    const p = this.geometry.position
    return { x: p[i * 3], y: p[i * 3 + 1], z: p[i * 3 + 2], face: this.geometry.face[i] }
  }

  layerOf(facelet: number, axis: number): number {
    return this.geometry.layerOf(facelet, axis)
  }

  /** A random scramble that never turns the same layer twice running. */
  scramble(rng: Rng, length: number): Move[] {
    const moves: Move[] = []
    let previous = -1
    while (moves.length < length) {
      const axis = rng.int(0, 2) as 0 | 1 | 2
      const layer = rng.int(0, this.size - 1)
      if (axis * this.size + layer === previous) continue
      previous = axis * this.size + layer
      moves.push({ axis, layer, turns: rng.int(1, 3) as 1 | 2 | 3 })
    }
    return moves
  }

  /**
   * Works out a solution without changing this cube.
   *
   * Method: fix the parity of each kind of piece with single turns, so that
   * every remaining arrangement is an even permutation; then solve the pieces
   * three at a time with commutators that disturb nothing else. Centres go
   * first, then edges, then corners.
   */
  solve(): SolveStep[] {
    const geometry = this.geometry
    const work = this.clone()
    const steps: { id: number; phase: Phase }[] = []
    const play = (id: number, phase: Phase) => {
      work.applyId(id)
      steps.push({ id, phase })
    }
    const target = work.frame()
    const colors = work.colors
    const order: Kind[] = ['centre', 'edge', 'corner']
    const phaseOf: Record<Kind, Phase> = { centre: 'centres', edge: 'edges', corner: 'corners' }

    /** The facelet where the sticker now at `facelet` belongs. */
    const home = (orbit: Orbit, facelet: number): number => {
      const piece = geometry.cubies[geometry.cubie[facelet]]
      search: for (const candidate of orbit.facelets) {
        if (target[geometry.face[candidate]] !== colors[facelet]) continue
        const slot = geometry.cubies[geometry.cubie[candidate]]
        for (const other of piece) {
          if (other === facelet) continue
          if (!slot.some((there) => there !== candidate && target[geometry.face[there]] === colors[other])) continue search
        }
        return candidate
      }
      throw new Error('Sticker has no home: the cube is not in a reachable state')
    }
    const pieceSolved = (facelet: number) => geometry.cubies[geometry.cubie[facelet]].every((i) => colors[i] === target[geometry.face[i]])

    // --- Parity. A quarter turn of a face swaps the parity of the corners (and
    // of the middle edges with them); a quarter turn of an inner slice swaps the
    // parity of the edge pieces at that depth.
    // Corners go first: on an odd cube their turn also settles the middle edges.
    const middle = (this.size - 1) / 2
    for (const orbit of [...geometry.orbits].sort((x, y) => Number(y.kind === 'corner') - Number(x.kind === 'corner'))) {
      if (orbit.kind === 'centre') continue
      const seen = new Set<number>()
      let odd = false
      for (const start of orbit.facelets) {
        let length = 0
        for (let at = start; !seen.has(geometry.cubie[at]); at = home(orbit, at)) {
          seen.add(geometry.cubie[at])
          length++
        }
        if (length > 0 && length % 2 === 0) odd = !odd
      }
      if (!odd) continue
      if (orbit.kind === 'corner') play(geometry.moveId(1, this.size - 1, 1), 'parity')
      else {
        // The depth of this orbit's pieces is the layer its edge stickers sit in.
        const depth = Math.min(...[0, 1, 2].map((axis) => geometry.layerOf(orbit.facelets[0], axis)).filter((layer) => layer > 0 && layer < this.size - 1))
        if (Number.isFinite(depth) && depth !== middle) play(geometry.moveId(0, depth, 1), 'parity')
      }
    }

    const cycle = (orbit: Orbit, from: number, to: number, spare: number, phase: Phase) => {
      const setup = geometry.setup(orbit, from, to, spare)
      for (const id of setup) play(id, phase)
      for (const id of orbit.macro) play(id, phase)
      for (let k = setup.length - 1; k >= 0; k--) play(geometry.inverse(setup[k]), phase)
    }

    for (const kind of order) {
      for (const orbit of geometry.orbits) {
        if (orbit.kind !== kind) continue
        const phase = phaseOf[kind]
        const { facelets } = orbit
        for (let guard = 0; guard < 400; guard++) {
          if (kind === 'centre') {
            const to = facelets.find((i) => colors[i] !== target[geometry.face[i]])
            if (to === undefined) break
            const wanted = target[geometry.face[to]]
            const from = facelets.find((i) => colors[i] === wanted && target[geometry.face[i]] !== wanted)!
            const unsolved = (i: number) => i !== to && i !== from && colors[i] !== target[geometry.face[i]]
            // Best: a third place that wants the colour being pushed out. Failing that any
            // unsolved place; failing that a solved one of the same colour, which stays solved.
            const spare =
              facelets.find((i) => unsolved(i) && target[geometry.face[i]] === colors[to]) ??
              facelets.find(unsolved) ??
              facelets.find((i) => i !== to && i !== from && colors[i] === colors[to] && target[geometry.face[i]] === colors[to])!
            cycle(orbit, from, to, spare, phase)
            continue
          }

          const to = facelets.find((i) => !pieceSolved(i))
          if (to === undefined) break
          // Where is the sticker that belongs here?
          const from = facelets.find((i) => home(orbit, i) === to)!
          const here = geometry.cubie[to]
          const there = geometry.cubie[from]
          const elsewhere = (i: number) => geometry.cubie[i] !== here && geometry.cubie[i] !== there
          if (here !== there) {
            // Send the piece being pushed out straight home if that is somewhere else again.
            const onward = home(orbit, to)
            const spare = elsewhere(onward) ? onward : (facelets.find((i) => elsewhere(i) && !pieceSolved(i)) ?? facelets.find(elsewhere)!)
            cycle(orbit, from, to, spare, phase)
          } else {
            // Right place, wrong way round. Cycle it out with two others; the passes that
            // follow bring all three back the right way.
            const second = facelets.find((i) => geometry.cubie[i] !== here && !pieceSolved(i)) ?? facelets.find((i) => geometry.cubie[i] !== here)!
            const third =
              facelets.find((i) => geometry.cubie[i] !== here && geometry.cubie[i] !== geometry.cubie[second] && !pieceSolved(i)) ??
              facelets.find((i) => geometry.cubie[i] !== here && geometry.cubie[i] !== geometry.cubie[second])!
            cycle(orbit, to, second, third, phase)
          }
        }
      }
    }
    if (!work.isSolved()) throw new Error('Solver finished without solving the cube')

    // Merge consecutive turns of the same layer, which mostly appear where one
    // cycle's undo meets the next cycle's setup.
    const merged: { id: number; phase: Phase }[] = []
    for (const step of steps) {
      const top = merged[merged.length - 1]
      if (top && Math.floor(top.id / 3) === Math.floor(step.id / 3)) {
        const turns = ((top.id % 3) + 1 + (step.id % 3) + 1) % 4
        merged.pop()
        if (turns !== 0) merged.push({ id: step.id - (step.id % 3) + turns - 1, phase: step.phase })
      } else {
        merged.push(step)
      }
    }
    return merged.map(({ id, phase }) => ({ ...geometry.toMove(id), phase }))
  }

  private applyId(id: number): void {
    const perm = this.geometry.perms[id]
    this.scratch.set(this.colors)
    for (let i = 0; i < perm.length; i++) this.colors[perm[i]] = this.scratch[i]
  }

  /**
   * The colour each face should end up. Odd cubes have fixed middle centres
   * that decide it. Even cubes have none, so one corner is taken as already
   * solved and the other faces follow from it.
   */
  private frame(): Uint8Array {
    const n = this.size
    const target = new Uint8Array(6)
    if (n % 2 === 1) {
      const middle = ((n - 1) / 2) * n + (n - 1) / 2
      for (let face = 0; face < 6; face++) target[face] = this.colors[face * n * n + middle]
    } else {
      for (let i = 0; i < this.count; i++) {
        const p = this.geometry.position
        if (p[i * 3] > -n + 1 || p[i * 3 + 1] > -n + 1 || p[i * 3 + 2] > -n + 1) continue
        const face = this.geometry.face[i]
        target[face] = this.colors[i]
        target[face ^ 1] = this.colors[i] ^ 1
      }
    }
    return target
  }
}

export type CubeStatus = 'idle' | 'scrambling' | 'solving' | 'solved'

/**
 * Runs a cube through scrambles and solves one animated turn at a time.
 */
export class CubeLogic {
  readonly cube: Cube
  status: CubeStatus = 'solved'
  /** Turns per second while solving. */
  speed = 6
  /** The turn in progress, and how far through it is (0..1). */
  current: Move | null = null
  progress = 0
  phase: Phase | null = null
  /** Turns made and planned in the current solve. */
  done = 0
  total = 0
  solveTime = 0
  solves = 0
  /** Turns completed during the last step, for sound. */
  ticks = 0
  onSolved: (() => void) | null = null

  private queue: (Move & { phase?: Phase })[] = []

  constructor(
    readonly size: number,
    private rng: Rng,
  ) {
    this.cube = new Cube(size)
  }

  get busy(): boolean {
    return this.current !== null || this.queue.length > 0
  }

  get remaining(): number {
    return this.queue.length + (this.current ? 1 : 0)
  }

  /** Turns per second right now: scrambles run faster than solves. */
  get rate(): number {
    if (!this.busy) return 0
    return this.status === 'scrambling' ? Math.max(this.speed * 2, 10) : this.speed
  }

  scramble(): void {
    if (this.busy) return
    this.queue = this.cube.scramble(this.rng, 12 + this.size * 6)
    this.status = 'scrambling'
    this.phase = null
    this.done = 0
    this.total = 0
  }

  solve(): void {
    if (this.busy || this.cube.isSolved()) return
    this.queue = this.cube.solve()
    this.status = 'solving'
    this.done = 0
    this.total = this.queue.length
    this.solveTime = 0
  }

  /** A turn made by hand. Ignored while the machine is working. */
  turn(move: Move): boolean {
    if (this.status === 'scrambling' || this.status === 'solving') return false
    this.queue.push(move)
    this.status = 'idle'
    this.phase = null
    return true
  }

  step(dt: number): void {
    this.ticks = 0
    if (this.status === 'solving') this.solveTime += dt
    let budget = dt * (this.status === 'idle' ? Math.max(this.speed, 5) : this.rate || this.speed)
    while (budget > 0) {
      if (!this.current) {
        const next = this.queue.shift()
        if (!next) break
        this.current = next
        this.progress = 0
        if (next.phase) this.phase = next.phase
      }
      const used = Math.min(budget, 1 - this.progress)
      this.progress += used
      budget -= used
      if (this.progress < 1 - 1e-9) break
      this.cube.apply(this.current)
      this.current = null
      this.progress = 0
      this.ticks++
      if (this.status === 'solving') this.done++
    }
    if (this.busy) return
    if (this.status === 'scrambling') this.status = 'idle'
    else if (this.status === 'solving') {
      this.status = 'solved'
      this.solves++
      this.onSolved?.()
    } else if (this.status === 'idle' && this.cube.isSolved()) this.status = 'solved'
  }
}
