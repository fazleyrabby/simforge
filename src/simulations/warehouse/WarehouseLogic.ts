import type { Rng } from '../core/random'

export type CellKind = 'floor' | 'shelf' | 'wall' | 'station' | 'dock'
export type RobotState = 'idle' | 'toPick' | 'loading' | 'toStation' | 'unloading' | 'toDock' | 'charging'

/** Moves a robot may make out of a cell: N, E, S, W as bit flags. */
export const NORTH = 1
export const EAST = 2
export const SOUTH = 4
export const WEST = 8
const DIRECTIONS = [
  { bit: NORTH, dx: 0, dy: -1 },
  { bit: EAST, dx: 1, dy: 0 },
  { bit: SOUTH, dx: 0, dy: 1 },
  { bit: WEST, dx: -1, dy: 0 },
]

export interface Layout {
  width: number
  height: number
  kinds: CellKind[]
  /** Allowed exits per cell. Aisles are one-way, so most cells have a single exit. */
  exits: Uint8Array
  /** For each shelf cell, the aisle cell a robot stands in to pick from it. */
  pickFace: Int32Array
  shelves: number[]
  stations: number[]
  docks: number[]
}

export interface Order {
  id: number
  shelf: number
  created: number
  rush: boolean
}

export interface Robot {
  id: number
  /** Cell the robot occupies (and has reserved). */
  cell: number
  /** Cell it is moving into (also reserved), or -1 when standing still. */
  next: number
  /** 0..1 progress from cell to next. */
  progress: number
  prevProgress: number
  /** Heading in radians, for rendering. */
  heading: number
  state: RobotState
  path: number[]
  home: number
  order: Order | null
  station: number
  /** Seconds left of loading, unloading or being stuck. */
  timer: number
  waiting: number
  battery: number
  distance: number
}

export interface WarehouseParams {
  /** New orders per minute. */
  orderRate: number
  /** Cells per second. */
  speed: number
}

const HANDLING_TIME = 1.2
/** Battery used per cell travelled, and regained per second on the dock. */
const DRAIN_PER_CELL = 0.004
const CHARGE_RATE = 0.12
const LOW_BATTERY = 0.3
const REPLAN_AFTER = 2
const QUEUE_LIMIT = 60

/**
 * Builds a warehouse floor with one-way traffic.
 *
 * Shelves stand in column pairs between vertical aisles. Aisles alternate
 * southbound and northbound, a lane along the top runs west and one along the
 * bottom runs east, so traffic circulates and no two robots can ever meet head
 * on. Docks hang off the top lane, packing stations off the bottom lane.
 */
export function generateLayout(rng: Rng, aisleCount: number, storageRows: number, stationCount: number, dockCount: number): Layout {
  // An even number of aisles makes the last one northbound, closing the loop.
  const aisles = aisleCount + (aisleCount % 2)
  const width = 3 * (aisles - 1) + 1
  const height = storageRows + 4
  const kinds: CellKind[] = new Array(width * height).fill('shelf')
  const exits = new Uint8Array(width * height)
  const at = (x: number, y: number) => y * width + x
  const topLane = 1
  const bottomLane = height - 2
  const crossRow = 2 + rng.int(Math.floor(storageRows * 0.35), Math.floor(storageRows * 0.6))
  const crossEast = rng.chance(0.5)

  for (let x = 0; x < width; x++) {
    // Edge rows are wall until docks and stations are carved into them.
    kinds[at(x, 0)] = 'wall'
    kinds[at(x, height - 1)] = 'wall'
    kinds[at(x, topLane)] = 'floor'
    exits[at(x, topLane)] = x > 0 ? WEST : 0
    kinds[at(x, bottomLane)] = 'floor'
    exits[at(x, bottomLane)] = x < width - 1 ? EAST : 0
  }
  for (let aisle = 0; aisle < aisles; aisle++) {
    const x = aisle * 3
    const south = aisle % 2 === 0
    for (let y = topLane; y <= bottomLane; y++) {
      kinds[at(x, y)] = 'floor'
      if (y === topLane && south) exits[at(x, y)] |= SOUTH
      else if (y === bottomLane && !south) exits[at(x, y)] |= NORTH
      else if (y > topLane && y < bottomLane) exits[at(x, y)] |= south ? SOUTH : NORTH
    }
  }
  // One cross aisle cuts through the shelving so robots can change aisle mid-block.
  for (let x = 0; x < width; x++) {
    const cell = at(x, crossRow)
    kinds[cell] = 'floor'
    if (crossEast ? x < width - 1 : x > 0) exits[cell] |= crossEast ? EAST : WEST
  }
  const shelves: number[] = []
  const pickFace = new Int32Array(width * height).fill(-1)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = at(x, y)
      if (kinds[cell] !== 'shelf') continue
      shelves.push(cell)
      pickFace[cell] = x % 3 === 1 ? at(x - 1, y) : at(x + 1, y)
    }
  }

  /** Evenly spaced pockets along an edge row, each joined to its lane cell both ways. */
  const pockets = (count: number, row: number, lane: number, kind: CellKind, enter: number, leave: number) => {
    const cells: number[] = []
    for (let i = 0; i < count; i++) {
      // Strictly increasing for count <= width, so every pocket gets its own column.
      const x = Math.floor(((i + 0.5) * width) / count)
      const cell = at(x, row)
      kinds[cell] = kind
      exits[cell] = leave
      exits[at(x, lane)] |= enter
      cells.push(cell)
    }
    return cells
  }
  const docks = pockets(Math.min(dockCount, width), 0, topLane, 'dock', NORTH, SOUTH)
  const stations = pockets(Math.min(stationCount, width), height - 1, bottomLane, 'station', SOUTH, NORTH)

  return { width, height, kinds, exits, pickFace, shelves, stations, docks }
}

/** Cells reachable in one legal move. */
export function neighbours(layout: Layout, cell: number, out: number[]): number[] {
  out.length = 0
  const x = cell % layout.width
  const y = Math.floor(cell / layout.width)
  const allowed = layout.exits[cell]
  for (const direction of DIRECTIONS) {
    if (!(allowed & direction.bit)) continue
    const nx = x + direction.dx
    const ny = y + direction.dy
    if (nx < 0 || ny < 0 || nx >= layout.width || ny >= layout.height) continue
    const next = ny * layout.width + nx
    const kind = layout.kinds[next]
    if (kind !== 'shelf' && kind !== 'wall') out.push(next)
  }
  return out
}

/**
 * A* over the directed floor graph. Manhattan distance never overestimates,
 * even with one-way aisles, so the first path found is a shortest one.
 * `avoid` adds a cost to cells currently held by other robots when replanning.
 */
export function findPath(layout: Layout, from: number, to: number, avoid?: (cell: number) => boolean): number[] | null {
  if (from === to) return []
  const { width } = layout
  const size = layout.kinds.length
  const cost = new Float32Array(size).fill(Infinity)
  const parent = new Int32Array(size).fill(-1)
  const closed = new Uint8Array(size)
  const tx = to % width
  const ty = Math.floor(to / width)
  const heuristic = (cell: number) => Math.abs((cell % width) - tx) + Math.abs(Math.floor(cell / width) - ty)

  // Small graphs: a linear scan for the best open node is simpler than a heap and fast enough.
  const open: number[] = [from]
  const score = new Float32Array(size).fill(Infinity)
  cost[from] = 0
  score[from] = heuristic(from)
  const around: number[] = []
  while (open.length > 0) {
    let best = 0
    for (let i = 1; i < open.length; i++) if (score[open[i]] < score[open[best]]) best = i
    const current = open[best]
    open[best] = open[open.length - 1]
    open.pop()
    if (current === to) {
      const path: number[] = []
      for (let cell = to; cell !== from; cell = parent[cell]) path.push(cell)
      return path.reverse()
    }
    if (closed[current]) continue
    closed[current] = 1
    for (const next of neighbours(layout, current, around)) {
      if (closed[next]) continue
      // Pockets are destinations only; never route through someone else's dock or station.
      if (next !== to && layout.kinds[next] !== 'floor') continue
      const step = cost[current] + 1 + (avoid?.(next) ? 12 : 0)
      if (step >= cost[next]) continue
      cost[next] = step
      parent[next] = current
      score[next] = step + heuristic(next)
      open.push(next)
    }
  }
  return null
}

/**
 * A fleet of warehouse robots, independent of rendering.
 *
 * Orders arrive for random shelves. The dispatcher gives each to the nearest
 * free robot, which drives to the shelf's pick face, loads a tote, carries it
 * to the least busy packing station and unloads. Every cell is reserved by at
 * most one robot, so robots queue behind one another instead of colliding,
 * and a robot stuck in a queue for too long plans a way around it.
 */
export class WarehouseLogic {
  readonly robots: Robot[] = []
  readonly queue: Order[] = []
  /** Robot id holding each cell, or -1. */
  readonly reserved: Int16Array
  time = 0
  created = 0
  completed = 0
  dropped = 0
  onComplete: ((order: Order, robot: Robot) => void) | null = null
  onPick: ((order: Order, robot: Robot) => void) | null = null

  private orderDebt = 0
  private nextOrder = 0
  private completions: number[] = []
  private latencies: number[] = []

  constructor(
    private rng: Rng,
    readonly layout: Layout,
    robotCount: number,
    public params: WarehouseParams,
  ) {
    this.reserved = new Int16Array(layout.kinds.length).fill(-1)
    const count = Math.min(robotCount, layout.docks.length)
    for (let i = 0; i < count; i++) {
      const home = layout.docks[i]
      this.reserved[home] = i
      this.robots.push({
        id: i,
        cell: home,
        next: -1,
        progress: 0,
        prevProgress: 0,
        heading: Math.PI / 2,
        state: 'idle',
        path: [],
        home,
        order: null,
        station: -1,
        timer: 0,
        waiting: 0,
        battery: 0.6 + rng.range(0, 0.4),
        distance: 0,
      })
    }
  }

  /** Queue an order for a specific shelf, ahead of everything else. */
  rush(shelf: number): Order | null {
    if (this.layout.pickFace[shelf] < 0) return null
    const order: Order = { id: this.nextOrder++, shelf, created: this.time, rush: true }
    this.created++
    this.queue.unshift(order)
    return order
  }

  /** Add a batch of ordinary orders at once. */
  surge(count: number): void {
    for (let i = 0; i < count; i++) this.enqueue()
  }

  step(dt: number): void {
    this.time += dt
    this.orderDebt += (dt * this.params.orderRate) / 60
    while (this.orderDebt >= 1) {
      this.orderDebt -= 1
      this.enqueue()
    }
    this.dispatch()
    for (const robot of this.robots) this.stepRobot(robot, dt)
    while (this.completions.length > 0 && this.completions[0] < this.time - 60) this.completions.shift()
  }

  get busyRobots(): number {
    return this.robots.filter((robot) => robot.state !== 'idle' && robot.state !== 'charging').length
  }

  get waitingRobots(): number {
    return this.robots.filter((robot) => robot.waiting > 0.4).length
  }

  get averageBattery(): number {
    return this.robots.reduce((sum, robot) => sum + robot.battery, 0) / Math.max(this.robots.length, 1)
  }

  /** Orders in the queue or on a robot. */
  get openOrders(): number {
    return this.queue.length + this.robots.filter((robot) => robot.order !== null).length
  }

  /** Completed orders per minute over a rolling window of up to 60 s. */
  throughput(): number {
    const window = Math.min(60, Math.max(this.time, 5))
    return (this.completions.length / window) * 60
  }

  /** Mean seconds from an order arriving to its tote reaching a station. */
  averageLatency(): number {
    if (this.latencies.length === 0) return 0
    return this.latencies.reduce((sum, value) => sum + value, 0) / this.latencies.length
  }

  private enqueue(): void {
    if (this.queue.length >= QUEUE_LIMIT) {
      this.dropped++
      return
    }
    this.created++
    this.queue.push({ id: this.nextOrder++, shelf: this.rng.pick(this.layout.shelves), created: this.time, rush: false })
  }

  /** Hand queued orders to the closest free robots. */
  private dispatch(): void {
    while (this.queue.length > 0) {
      const order = this.queue[0]
      const target = this.layout.pickFace[order.shelf]
      const tx = target % this.layout.width
      const ty = Math.floor(target / this.layout.width)
      let chosen: Robot | null = null
      let nearest = Infinity
      for (const robot of this.robots) {
        const free = robot.state === 'idle' || (robot.state === 'toDock' && robot.battery > LOW_BATTERY)
        if (!free || robot.battery <= LOW_BATTERY) continue
        const from = robot.next >= 0 ? robot.next : robot.cell
        const distance = Math.abs((from % this.layout.width) - tx) + Math.abs(Math.floor(from / this.layout.width) - ty)
        if (distance < nearest) {
          nearest = distance
          chosen = robot
        }
      }
      if (!chosen) return
      this.queue.shift()
      chosen.order = order
      chosen.state = 'toPick'
      this.route(chosen, target)
    }
  }

  private route(robot: Robot, target: number, avoidOthers = false): void {
    const from = robot.next >= 0 ? robot.next : robot.cell
    const avoid = avoidOthers ? (cell: number) => this.reserved[cell] >= 0 && this.reserved[cell] !== robot.id : undefined
    robot.path = findPath(this.layout, from, target, avoid) ?? []
  }

  /** The station with the fewest robots at or heading to it. */
  private quietestStation(): number {
    let best = this.layout.stations[0]
    let fewest = Infinity
    for (const station of this.layout.stations) {
      let load = 0
      for (const robot of this.robots) if (robot.station === station) load++
      if (load < fewest) {
        fewest = load
        best = station
      }
    }
    return best
  }

  private stepRobot(robot: Robot, dt: number): void {
    robot.prevProgress = robot.progress

    if (robot.state === 'loading' || robot.state === 'unloading') {
      robot.timer -= dt
      if (robot.timer > 0) return
      if (robot.state === 'loading') {
        robot.station = this.quietestStation()
        robot.state = 'toStation'
        this.route(robot, robot.station)
      } else {
        const order = robot.order!
        this.completed++
        this.completions.push(this.time)
        this.latencies.push(this.time - order.created)
        if (this.latencies.length > 40) this.latencies.shift()
        this.onComplete?.(order, robot)
        robot.order = null
        robot.station = -1
        // Clear the station for the next robot: head home until the dispatcher says otherwise.
        robot.state = 'toDock'
        this.route(robot, robot.home)
      }
      return
    }

    if (robot.state === 'charging') {
      robot.battery = Math.min(1, robot.battery + CHARGE_RATE * dt)
      if (robot.battery >= 0.95) robot.state = 'idle'
      return
    }
    if (robot.state === 'idle') {
      if (robot.cell === robot.home) robot.battery = Math.min(1, robot.battery + CHARGE_RATE * dt)
      return
    }

    // Travelling.
    if (robot.next < 0) {
      if (robot.path.length === 0) {
        this.arrive(robot)
        return
      }
      const wanted = robot.path[0]
      // Do not pull up beside an occupied station: the robot inside needs that lane cell to leave.
      const beyond = robot.path[1]
      const pocketBusy =
        beyond !== undefined && this.layout.kinds[beyond] !== 'floor' && this.reserved[beyond] >= 0 && this.reserved[beyond] !== robot.id
      if (this.reserved[wanted] >= 0 || pocketBusy) {
        // Queue behind whoever holds the cell; after a while, look for a way around.
        robot.waiting += dt
        if (robot.waiting > REPLAN_AFTER) {
          robot.waiting = 0.5
          this.route(robot, robot.path[robot.path.length - 1], true)
        }
        return
      }
      robot.waiting = 0
      robot.path.shift()
      robot.next = wanted
      this.reserved[wanted] = robot.id
      robot.progress = 0
      robot.prevProgress = 0
      const { width } = this.layout
      robot.heading = Math.atan2(Math.floor(wanted / width) - Math.floor(robot.cell / width), (wanted % width) - (robot.cell % width))
    }

    robot.progress += this.params.speed * dt
    if (robot.progress >= 1) {
      this.reserved[robot.cell] = -1
      robot.cell = robot.next
      robot.next = -1
      robot.progress = 0
      robot.prevProgress = 0
      robot.distance++
      robot.battery = Math.max(0.02, robot.battery - DRAIN_PER_CELL)
    }
  }

  /** Reached the end of the current route. */
  private arrive(robot: Robot): void {
    if (robot.state === 'toPick') {
      robot.state = 'loading'
      robot.timer = HANDLING_TIME
      this.onPick?.(robot.order!, robot)
    } else if (robot.state === 'toStation') {
      robot.state = 'unloading'
      robot.timer = HANDLING_TIME
    } else if (robot.state === 'toDock') {
      robot.state = robot.battery < 0.6 ? 'charging' : 'idle'
    }
  }
}
