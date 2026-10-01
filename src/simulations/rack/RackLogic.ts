import type { Rng } from '../core/random'

export type NodeStatus = 'idle' | 'busy' | 'throttled' | 'down'

export interface Job {
  id: number
  /** Compute units still to process. */
  work: number
  totalWork: number
  /** Simulation time the job entered the queue. */
  arrival: number
}

export interface ServerNode {
  id: number
  /** Nominal processing rate in compute units per second at full health. */
  capacity: number
  /** Maximum concurrent jobs. */
  slots: number
  /** Core temperature in °C. */
  temp: number
  status: NodeStatus
  jobs: Job[]
  /** Current electrical draw in kW. */
  power: number
  /** Seconds remaining before a crashed node reboots. */
  boot: number
  /** Switched off by the operator; stays down until switched back on. */
  held: boolean
}

export interface RackParams {
  /** Jobs arriving per minute across the whole rack. */
  arrivalRate: number
  /** Mean compute units of work per job. */
  jobSize: number
  /** Cooling effort, 0..1, driving the CRAC airflow. */
  cooling: number
  /** PDU power budget for the whole rack in kW. */
  powerCap: number
  /** Whether nodes can overheat and crash. */
  failures: boolean
}

export const T_AMBIENT = 22
export const T_THROTTLE = 75
export const T_CRIT = 92
export const BOOT_TIME = 8
/** Longest backlog the queue holds before it sheds load. */
export const QUEUE_MAX = 240

const CAPACITY = 100
const SLOTS = 4
const P_IDLE = 0.08
const P_MAX = 0.46
/** °C per second of heating per kW drawn. */
const HEAT_GAIN = 160
const COOL_BASE = 0.4
const COOL_RANGE = 1.1
/** Fraction of nominal capacity left at the critical temperature. */
const THROTTLE_FLOOR = 0.4
/** Mean seconds between random hardware faults across the whole rack. */
const FAULT_MTBF = 70

/** Cooling coefficient (1/s) for a cooling setting. */
export function coolingRate(cooling: number): number {
  return COOL_BASE + cooling * COOL_RANGE
}

/** Fraction of nominal capacity a node delivers at a given temperature. */
export function throttleFactor(temp: number): number {
  if (temp <= T_THROTTLE) return 1
  const span = (temp - T_THROTTLE) / (T_CRIT - T_THROTTLE)
  return Math.max(THROTTLE_FLOOR, 1 - span * (1 - THROTTLE_FLOOR))
}

/** Steady-state temperature of a node held at a constant electrical draw. */
export function steadyTemp(power: number, cooling: number): number {
  return T_AMBIENT + (power * HEAT_GAIN) / coolingRate(cooling)
}

/**
 * A rack of servers behind a workload scheduler, independent of rendering.
 *
 * Jobs arrive into one queue. A least-loaded scheduler places them on the
 * coolest node that has a free slot, but only while the rack stays under its
 * PDU budget. Busy nodes heat up, hot nodes throttle (doing less work, so
 * drawing less power and cooling themselves), and a node past the critical
 * temperature crashes, returning its jobs to the queue. Every bottleneck —
 * power, heat and node failure — therefore backs the queue up rather than
 * dropping work silently, until the backlog overflows and load is shed.
 */
export class RackLogic {
  readonly nodes: ServerNode[] = []
  readonly queue: Job[] = []
  time = 0
  arrived = 0
  completed = 0
  dropped = 0
  onDown: ((node: ServerNode) => void) | null = null

  private nextId = 0
  private spawnDebt = 0
  private completions: number[] = []
  private latencies: number[] = []

  constructor(
    private rng: Rng,
    nodeCount: number,
    public params: RackParams,
  ) {
    for (let i = 0; i < nodeCount; i++) {
      this.nodes.push({
        id: i,
        capacity: CAPACITY,
        slots: SLOTS,
        temp: T_AMBIENT + this.rng.range(0, 3),
        status: 'idle',
        jobs: [],
        power: P_IDLE,
        boot: 0,
        held: false,
      })
    }
  }

  step(dt: number): void {
    this.time += dt
    this.admit(dt)
    this.schedule()
    for (const node of this.nodes) this.stepNode(node, dt)
    this.trimWindows()
  }

  /** Inject a batch of jobs at once, as a traffic spike. */
  burst(count: number): void {
    for (let i = 0; i < count; i++) this.enqueue(this.createJob())
  }

  /** Bring a crashed node back online immediately. */
  reboot(nodeId: number): void {
    const node = this.nodes[nodeId]
    if (node.status === 'down' && !node.held) {
      node.boot = 0
      node.status = 'idle'
      node.temp = Math.min(node.temp, T_THROTTLE)
    }
  }

  /** Operator power switch. A node switched off hands its work back and stays down. */
  setPower(nodeId: number, on: boolean): void {
    const node = this.nodes[nodeId]
    if (on) {
      if (!node.held) return
      node.held = false
      node.boot = BOOT_TIME / 2
    } else if (!node.held) {
      node.held = true
      if (node.status !== 'down') this.takeDown(node)
    }
  }

  get runningNodes(): number {
    return this.nodes.filter((node) => node.status !== 'down').length
  }

  get runningJobs(): number {
    let count = 0
    for (const node of this.nodes) count += node.jobs.length
    return count
  }

  get totalPower(): number {
    let sum = 0
    for (const node of this.nodes) sum += node.power
    return sum
  }

  get maxTemp(): number {
    let max = 0
    for (const node of this.nodes) max = Math.max(max, node.temp)
    return max
  }

  get avgTemp(): number {
    let sum = 0
    for (const node of this.nodes) sum += node.temp
    return sum / this.nodes.length
  }

  /** Mean fraction of nominal capacity in use across online nodes, 0..1. */
  utilization(): number {
    let sum = 0
    let online = 0
    for (const node of this.nodes) {
      if (node.status === 'down') continue
      online++
      if (node.jobs.length > 0) sum += throttleFactor(node.temp)
    }
    return online > 0 ? sum / online : 0
  }

  /** Completed jobs per second over a rolling window. */
  throughput(): number {
    const window = Math.min(20, Math.max(3, this.time))
    const since = this.time - window
    let count = 0
    for (const t of this.completions) if (t > since) count++
    return count / window
  }

  /** Mean time from arrival to completion over recent jobs, in seconds. */
  avgLatency(): number {
    if (this.latencies.length === 0) return 0
    let sum = 0
    for (const value of this.latencies) sum += value
    return sum / this.latencies.length
  }

  private admit(dt: number): void {
    this.spawnDebt += (this.params.arrivalRate * dt) / 60
    while (this.spawnDebt >= 1) {
      this.spawnDebt -= 1
      this.enqueue(this.createJob())
    }
  }

  /** Place queued jobs on the coolest node with a free slot, within the PDU cap. */
  private schedule(): void {
    if (this.queue.length === 0) return
    const ready = this.nodes
      .filter((node) => node.status !== 'down' && node.jobs.length < node.slots)
      .sort((a, b) => a.temp - b.temp)

    for (const node of ready) {
      while (node.jobs.length < node.slots && this.queue.length > 0) {
        // Starting work here spins the node up to a busy draw; stop if that
        // would push the rack over its PDU budget.
        const projected = this.totalPower + (node.jobs.length === 0 ? P_MAX - node.power : 0)
        if (projected > this.params.powerCap) return
        node.jobs.push(this.queue.shift()!)
        node.power = P_MAX
      }
    }
  }

  private stepNode(node: ServerNode, dt: number): void {
    if (node.status === 'down') {
      node.power = 0
      this.updateTemp(node, dt)
      if (node.held) return
      node.boot -= dt
      if (node.boot <= 0) node.status = 'idle'
      return
    }

    // Random hardware faults, independent of heat.
    if (this.params.failures && this.rng.next() < dt / (FAULT_MTBF * this.nodes.length)) {
      this.crash(node)
      return
    }

    const factor = throttleFactor(node.temp)
    if (node.jobs.length > 0) {
      const share = (node.capacity * factor * dt) / node.jobs.length
      for (const job of node.jobs) job.work -= share
      // Several short jobs can finish in one step.
      for (let i = node.jobs.length - 1; i >= 0; i--) {
        if (node.jobs[i].work <= 0) {
          this.finish(node.jobs[i])
          node.jobs.splice(i, 1)
        }
      }
      node.power = node.jobs.length > 0 ? P_IDLE + factor * (P_MAX - P_IDLE) : P_IDLE
    } else {
      node.power = P_IDLE
    }

    this.updateTemp(node, dt)

    if (this.params.failures && node.temp >= T_CRIT) {
      this.crash(node)
      return
    }

    if (node.jobs.length === 0) node.status = 'idle'
    else node.status = node.temp > T_THROTTLE ? 'throttled' : 'busy'
  }

  private updateTemp(node: ServerNode, dt: number): void {
    const heat = node.power * HEAT_GAIN
    const cool = coolingRate(this.params.cooling) * (node.temp - T_AMBIENT)
    node.temp = Math.max(T_AMBIENT, node.temp + (heat - cool) * dt)
  }

  private crash(node: ServerNode): void {
    this.takeDown(node)
    this.onDown?.(node)
  }

  private takeDown(node: ServerNode): void {
    node.status = 'down'
    node.boot = BOOT_TIME
    node.power = 0
    // Unfinished work goes back to the front of the queue to be rescheduled.
    for (let i = node.jobs.length - 1; i >= 0; i--) this.queue.unshift(node.jobs[i])
    node.jobs.length = 0
  }

  private finish(job: Job): void {
    this.completed++
    this.completions.push(this.time)
    this.latencies.push(this.time - job.arrival)
    if (this.latencies.length > 120) this.latencies.shift()
  }

  private enqueue(job: Job): void {
    if (this.queue.length >= QUEUE_MAX) this.dropped++
    else this.queue.push(job)
  }

  private createJob(): Job {
    this.arrived++
    const work = this.params.jobSize * this.rng.range(0.5, 1.5)
    return { id: this.nextId++, work, totalWork: work, arrival: this.time }
  }

  private trimWindows(): void {
    const cutoff = this.time - 20
    while (this.completions.length > 0 && this.completions[0] < cutoff) this.completions.shift()
  }
}
