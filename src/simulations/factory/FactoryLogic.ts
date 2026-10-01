import type { Rng } from '../core/random'

export type ProductState = 'raw' | 'mixed' | 'shaped' | 'baking' | 'cooling' | 'packaged'
export type MachineKind = 'dispenser' | 'mixer' | 'cutter' | 'oven' | 'cooler' | 'packager'
export type MachineStatus = 'idle' | 'processing' | 'blocked' | 'jammed'

export interface Product {
  id: number
  lane: number
  /** Distance along the lane. */
  s: number
  prevS: number
  state: ProductState
  /** Number of machines this product has cleared; decides which machine it needs next. */
  stage: number
  /** Time spent inside the current tunnel machine. */
  dwell: number
}

export interface Machine {
  id: number
  kind: MachineKind
  lane: number
  /** Zone along the lane. Single-item machines have start === end. */
  start: number
  end: number
  status: MachineStatus
  /** 0..1 progress of the item being processed (single-item machines). */
  progress: number
  item: Product | null
  /** Seconds until a jam clears on its own. */
  repair: number
  processed: number
}

export interface FactoryParams {
  /** Raw units entering per minute, across all lanes. */
  spawnRate: number
  conveyorSpeed: number
  machineSpeed: number
  ovenTemp: number
  failures: boolean
  /** Mean seconds between failures across the whole factory. */
  mtbf: number
}

export const LANE_LENGTH = 34
export const MIN_GAP = 0.9
export const REPAIR_TIME = 7
const SPAWN_S = 1
const BAKE_TIME = 6
const COOL_TIME = 3.5

interface Station {
  kind: MachineKind
  start: number
  end: number
  /** Stage a product must be at to be worked on here. */
  needs: number
  /** State the product takes on. */
  gives: ProductState
  /** Seconds of work for single-item machines at machine speed 1. */
  time: number
}

export const STATIONS: Station[] = [
  { kind: 'dispenser', start: SPAWN_S, end: SPAWN_S, needs: -1, gives: 'raw', time: 0 },
  { kind: 'mixer', start: 5, end: 5, needs: 0, gives: 'mixed', time: 1.2 },
  { kind: 'cutter', start: 9, end: 9, needs: 1, gives: 'shaped', time: 0.6 },
  { kind: 'oven', start: 12, end: 20, needs: 2, gives: 'baking', time: BAKE_TIME },
  { kind: 'cooler', start: 22, end: 28, needs: 3, gives: 'cooling', time: COOL_TIME },
  { kind: 'packager', start: 31, end: 31, needs: 4, gives: 'packaged', time: 0.8 },
]

const EPSILON = 1e-6

/**
 * The production line, independent of rendering.
 *
 * Products ride a conveyor and never overlap: each one stops MIN_GAP behind
 * the product ahead. A machine that is busy or jammed therefore backs the
 * line up behind it instead of dropping or stacking products.
 */
export class FactoryLogic {
  readonly machines: Machine[] = []
  /** Products per lane, ordered front (furthest along) to back. */
  readonly lanes: Product[][] = []
  time = 0
  completed = 0
  downtime = 0
  /** Distance the belt surface has travelled; drives the belt texture. */
  beltTravel = 0
  onJam: ((machine: Machine) => void) | null = null

  private pool: Product[] = []
  private nextId = 0
  private spawnDebt: number[] = []
  private completions: number[] = []
  private firstCompletion = -1

  constructor(
    private rng: Rng,
    readonly laneCount: number,
    public params: FactoryParams,
  ) {
    for (let lane = 0; lane < laneCount; lane++) {
      this.lanes.push([])
      this.spawnDebt.push(lane / laneCount)
      for (const station of STATIONS) {
        this.machines.push({
          id: this.machines.length,
          kind: station.kind,
          lane,
          start: station.start,
          end: station.end,
          status: 'idle',
          progress: 0,
          item: null,
          repair: 0,
          processed: 0,
        })
      }
    }
  }

  step(dt: number): void {
    const { params } = this
    this.time += dt
    this.beltTravel += params.conveyorSpeed * dt

    let anyJammed = false
    for (const machine of this.machines) {
      if (machine.status === 'jammed') {
        machine.repair -= dt
        if (machine.repair <= 0) machine.status = 'idle'
        else anyJammed = true
      } else if (params.failures) {
        // Running the oven hot makes it less reliable.
        const weight = machine.kind === 'oven' ? 1 + Math.max(0, (params.ovenTemp - 200) / 20) : 1
        if (this.rng.next() < (dt * weight) / (params.mtbf * this.machines.length)) this.jam(machine.id)
      }
    }
    if (anyJammed) this.downtime += dt

    for (let lane = 0; lane < this.laneCount; lane++) this.stepLane(lane, dt)
  }

  jam(machineId: number, duration = REPAIR_TIME): void {
    const machine = this.machines[machineId]
    if (machine.status === 'jammed') return
    machine.status = 'jammed'
    machine.repair = duration
    this.onJam?.(machine)
  }

  repair(machineId: number): void {
    const machine = this.machines[machineId]
    if (machine.status === 'jammed') machine.status = 'idle'
  }

  machineAt(lane: number, kind: MachineKind): Machine {
    return this.machines[lane * STATIONS.length + STATIONS.findIndex((station) => station.kind === kind)]
  }

  /** Seconds a product must spend inside a tunnel machine. */
  dwellTime(kind: MachineKind): number {
    const { ovenTemp, machineSpeed } = this.params
    if (kind === 'oven') return (BAKE_TIME * (180 / ovenTemp)) / machineSpeed
    return COOL_TIME / machineSpeed
  }

  get activeProducts(): number {
    let count = 0
    for (const lane of this.lanes) count += lane.length
    return count
  }

  get runningMachines(): number {
    return this.machines.filter((machine) => machine.status !== 'jammed').length
  }

  /** Packaged products over a rolling window of up to 60 seconds. */
  productionPerMinute(): number {
    if (this.firstCompletion < 0) return 0
    const window = Math.min(60, Math.max(5, this.time - this.firstCompletion))
    const since = this.time - window
    let count = 0
    for (const time of this.completions) if (time > since) count++
    return (count / window) * 60
  }

  /** Throughput of the slowest stage with no failures. */
  theoreticalPerMinute(): number {
    const { spawnRate, conveyorSpeed, machineSpeed } = this.params
    let perLane = Math.min(spawnRate / this.laneCount, (60 * conveyorSpeed) / MIN_GAP)
    for (const station of STATIONS) {
      if (station.kind === 'dispenser') continue
      if (station.start === station.end) {
        perLane = Math.min(perLane, 60 / (station.time / machineSpeed + MIN_GAP / conveyorSpeed))
      } else {
        const capacity = Math.floor((station.end - station.start) / MIN_GAP)
        perLane = Math.min(perLane, (60 * capacity) / this.dwellTime(station.kind))
      }
    }
    return perLane * this.laneCount
  }

  /** Actual production rate ÷ theoretical bottleneck rate, 0..1. */
  efficiency(): number {
    const theoretical = this.theoreticalPerMinute()
    if (theoretical <= 0) return 0
    return Math.min(1, this.productionPerMinute() / theoretical)
  }

  private stepLane(lane: number, dt: number): void {
    const { params } = this
    const products = this.lanes[lane]
    const base = lane * STATIONS.length

    // Single-item machines work on the product they hold.
    for (let i = 0; i < STATIONS.length; i++) {
      const station = STATIONS[i]
      const machine = this.machines[base + i]
      if (station.start !== station.end || !machine.item || machine.status === 'jammed') continue
      machine.progress += (dt * params.machineSpeed) / station.time
      if (machine.progress >= 1) {
        machine.item.stage++
        machine.item.state = station.gives
        machine.item = null
        machine.progress = 0
        machine.processed++
      }
    }

    const occupied: boolean[] = new Array(STATIONS.length).fill(false)
    const blocked: boolean[] = new Array(STATIONS.length).fill(false)

    for (let index = 0; index < products.length; index++) {
      const product = products[index]
      product.prevS = product.s
      const limit = index > 0 ? products[index - 1].s - MIN_GAP : Infinity
      let target = product.s + params.conveyorSpeed * dt

      for (let i = 1; i < STATIONS.length; i++) {
        const station = STATIONS[i]
        if (product.stage !== station.needs) continue
        const machine = this.machines[base + i]
        const jammed = machine.status === 'jammed'

        if (station.start === station.end) {
          // Stop at the machine and wait to be processed.
          target = Math.min(target, station.start)
          if (product.s >= station.start - EPSILON) {
            if (!machine.item && !jammed) {
              machine.item = product
              machine.progress = 0
            }
            occupied[i] = true
          }
        } else if (product.s < station.start) {
          // A jammed tunnel keeps its door shut.
          if (jammed) target = Math.min(target, station.start - 0.01)
          else if (target >= station.start) {
            product.state = station.gives
            product.dwell = 0
          }
        } else {
          occupied[i] = true
          if (jammed) {
            target = product.s
          } else {
            product.dwell += dt
            const done = product.dwell >= this.dwellTime(station.kind)
            if (done && product.s >= station.end - EPSILON) product.stage++
            else target = Math.min(target, station.end)
            if (done && limit < target) blocked[i] = true
          }
        }
      }

      product.s = Math.max(product.s, Math.min(target, limit))
    }

    // Finished products leave the end of the line.
    while (products.length > 0 && products[0].s >= LANE_LENGTH) {
      const product = products.shift()!
      if (product.stage === STATIONS.length - 1) {
        this.completed++
        this.completions.push(this.time)
        if (this.firstCompletion < 0) this.firstCompletion = this.time
      }
      this.pool.push(product)
    }
    while (this.completions.length > 0 && this.completions[0] < this.time - 60) this.completions.shift()

    // The dispenser only releases a product when there is room on the belt.
    const dispenser = this.machines[base]
    this.spawnDebt[lane] += (dt * params.spawnRate) / 60 / this.laneCount
    let dispenserBlocked = false
    if (this.spawnDebt[lane] >= 1) {
      const last = products[products.length - 1]
      const room = !last || last.s >= SPAWN_S + MIN_GAP
      if (room && dispenser.status !== 'jammed') {
        products.push(this.createProduct(lane))
        dispenser.processed++
        this.spawnDebt[lane] -= 1
      } else {
        // Hold the pending unit rather than queueing an unbounded backlog.
        this.spawnDebt[lane] = 1
        dispenserBlocked = true
      }
    }

    for (let i = 0; i < STATIONS.length; i++) {
      const machine = this.machines[base + i]
      if (machine.status === 'jammed') continue
      if (i === 0) machine.status = dispenserBlocked ? 'blocked' : 'idle'
      else if (blocked[i]) machine.status = 'blocked'
      else if (machine.item || (STATIONS[i].start !== STATIONS[i].end && occupied[i])) machine.status = 'processing'
      else machine.status = occupied[i] ? 'blocked' : 'idle'
    }
  }

  private createProduct(lane: number): Product {
    const product = this.pool.pop() ?? { id: 0, lane: 0, s: 0, prevS: 0, state: 'raw', stage: 0, dwell: 0 }
    product.id = this.nextId++
    product.lane = lane
    product.s = SPAWN_S
    product.prevS = SPAWN_S
    product.state = 'raw'
    product.stage = 0
    product.dwell = 0
    return product
  }
}
