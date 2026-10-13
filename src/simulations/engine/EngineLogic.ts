/**
 * A four-stroke petrol engine, independent of rendering.
 *
 * Each cylinder carries its own gas pressure through intake, compression,
 * combustion and exhaust. That pressure, acting on the piston through the
 * slider-crank geometry, is the only thing that turns the crankshaft; speed,
 * torque, idle, stalling and the effect of spark timing all follow from it.
 *
 * Angles are in crank degrees. One cycle is 720°: 0–180 intake, 180–360
 * compression, 360–540 power, 540–720 exhaust, with top dead centre at 0 and 360.
 */

export interface EngineParams {
  /** Throttle opening, 0..1. */
  throttle: number
  /** Brake torque at 3000 rpm, N·m. It rises with speed, like a dyno's absorber. */
  load: number
  /** Spark timing, degrees before top dead centre. */
  advance: number
  ignition: boolean
}

export type EngineStatus = 'off' | 'cranking' | 'running' | 'stalled'

export const BORE = 0.086
export const CRANK_RADIUS = 0.043
export const ROD_LENGTH = 0.143
export const COMPRESSION_RATIO = 10
const PISTON_AREA = (Math.PI * BORE * BORE) / 4
const SWEPT = PISTON_AREA * 2 * CRANK_RADIUS
const CLEARANCE = SWEPT / (COMPRESSION_RATIO - 1)

const P_ATM = 101325
const P_EXHAUST = 108000
const GAS_CONSTANT = 287
const GAMMA = 1.33
const INTAKE_TEMPERATURE = 320
const AIR_FUEL_RATIO = 14.7
const FUEL_ENERGY = 44e6
/** Share of the fuel's energy that ends up heating the gas rather than the walls. */
const HEAT_KEPT = 0.72
const BURN_DURATION = 55
const EXHAUST_OPENS = 500
const IDLE_RPM = 850
export const REV_LIMIT = 7000

/** Firing order for each inline layout; cylinders are numbered from 0 at the front. */
const FIRING_ORDERS: Record<number, number[]> = {
  1: [0],
  2: [0, 1],
  3: [0, 1, 2],
  4: [0, 2, 3, 1],
  6: [0, 4, 2, 5, 1, 3],
}

/** Distance of the piston below top dead centre, metres. */
export function pistonDrop(degrees: number): number {
  const a = (degrees * Math.PI) / 180
  const sin = Math.sin(a)
  return CRANK_RADIUS * (1 - Math.cos(a)) + ROD_LENGTH - Math.sqrt(ROD_LENGTH * ROD_LENGTH - CRANK_RADIUS * CRANK_RADIUS * sin * sin)
}

export function cylinderVolume(degrees: number): number {
  return CLEARANCE + PISTON_AREA * pistonDrop(degrees)
}

/** Torque per unit of pressure on the piston: the piston's travel per radian of crank, times its area. */
function leverage(degrees: number): number {
  const a = (degrees * Math.PI) / 180
  const sin = Math.sin(a)
  const cos = Math.cos(a)
  return PISTON_AREA * (CRANK_RADIUS * sin + (CRANK_RADIUS * CRANK_RADIUS * sin * cos) / Math.sqrt(ROD_LENGTH * ROD_LENGTH - CRANK_RADIUS * CRANK_RADIUS * sin * sin))
}

interface Cylinder {
  /** Where this cylinder's cycle starts, in degrees of the engine's cycle. */
  offset: number
  pressure: number
  temperature: number
  /** Trapped gas, kg, and the heat its fuel will release, J. */
  mass: number
  heat: number
  /** Crank angle at which this cycle's spark fires. */
  spark: number
}

export class EngineLogic {
  readonly cylinders: Cylinder[]
  status: EngineStatus = 'off'
  /** Position in the 720° cycle, and crank speed in rad/s. */
  angle = 0
  speed = 0
  /** Manifold pressure, Pa. */
  manifold = P_ATM
  /** Shaft torque after friction, smoothed over a few cycles, N·m. */
  torque = 0
  /** Fuel flow, kg/s. */
  fuelRate = 0
  /** Swing in crank speed across one cycle, as a fraction of the mean. */
  ripple = 0
  /** Pressure (Pa) and temperature (K) in cylinder 0 at each degree of its latest cycle. */
  readonly tracePressure = new Float32Array(720).fill(P_ATM)
  readonly traceTemperature = new Float32Array(720).fill(INTAKE_TEMPERATURE)
  /** Whether fuel is being burned right now (false when switched off or on the rev limiter). */
  firing = false

  private idleAir = 0.03
  private cranked = 0
  private clutch = 0
  private slowest = Infinity
  private fastest = 0
  private fuelPerCycle = 0

  constructor(
    count: number,
    readonly params: EngineParams,
  ) {
    const order = FIRING_ORDERS[count] ?? FIRING_ORDERS[4]
    this.cylinders = order.map(() => ({ offset: 0, pressure: P_ATM, temperature: INTAKE_TEMPERATURE, mass: 0, heat: 0, spark: 360 }))
    order.forEach((cylinder, turn) => (this.cylinders[cylinder].offset = (turn * 720) / order.length))
  }

  get rpm(): number {
    return (this.speed * 30) / Math.PI
  }

  /** Shaft power, W. */
  get power(): number {
    return this.torque * this.speed
  }

  /** Total swept volume, litres. */
  get displacement(): number {
    return this.cylinders.length * SWEPT * 1000
  }

  /** Share of the fuel's energy that reaches the shaft. */
  get efficiency(): number {
    return this.fuelRate > 1e-7 ? Math.max(0, this.power / (this.fuelRate * FUEL_ENERGY)) : 0
  }

  /** Where a cylinder is in its own cycle, 0..720. */
  phase(cylinder: number, angle = this.angle): number {
    return (((angle - this.cylinders[cylinder].offset) % 720) + 720) % 720
  }

  /** Engage the starter. */
  start(): void {
    if (!this.params.ignition || this.status === 'running') return
    this.status = 'cranking'
    this.cranked = 0
  }

  step(dt: number): void {
    // Fast engines sweep hundreds of degrees a frame; pressure needs steps of a couple of degrees.
    const sweep = (this.speed * dt * 180) / Math.PI
    const steps = Math.max(1, Math.ceil(sweep / 2))
    for (let i = 0; i < steps; i++) this.substep(dt / steps)

    const rpm = this.rpm
    if (this.status === 'cranking') {
      this.cranked += dt
      if (rpm > 500) this.status = 'running'
      else if (this.cranked > 4) this.status = 'stalled'
    } else if (this.status === 'running' && rpm < 150) {
      this.status = this.params.ignition ? 'stalled' : 'off'
    }
    if (!this.params.ignition && this.status === 'cranking') this.status = 'off'

    // Idle air: a slow governor that holds idle speed when the throttle is closed.
    if (this.status === 'running') {
      this.idleAir = Math.min(0.04, Math.max(0.004, this.idleAir + (IDLE_RPM - rpm) * dt * 0.00025))
    }
    this.fuelRate += (((this.fuelPerCycle * this.cylinders.length * rpm) / 120 - this.fuelRate) * dt) / 0.25
  }

  private substep(dt: number): void {
    const { params } = this
    const rpm = this.rpm
    const count = this.cylinders.length
    this.firing = params.ignition && rpm < REV_LIMIT && (this.status === 'running' || this.status === 'cranking')

    // The throttle and engine speed set the manifold pressure the cylinders fill from.
    const opening = Math.max(params.throttle, this.idleAir + Math.max(0, (IDLE_RPM - rpm) * 0.00008))
    const filling = (9 * opening) / (rpm / 1000 + 0.3)
    this.manifold = P_ATM * (0.12 + 0.88 * (1 - Math.exp(-filling)))

    const turned = (this.speed * dt * 180) / Math.PI
    let torque = 0
    this.cylinders.forEach((cylinder, index) => {
      const from = this.phase(index)
      const to = from + turned
      const before = cylinderVolume(from)
      const after = cylinderVolume(to)
      const start = cylinder.pressure

      if (from < 180) {
        // Intake: the cylinder fills toward manifold pressure.
        cylinder.pressure += (this.manifold - cylinder.pressure) * (1 - Math.exp(-turned / 12))
        cylinder.temperature = INTAKE_TEMPERATURE
        if (to >= 180) {
          // Intake valve closes: this is the charge the cycle will burn.
          cylinder.mass = (cylinder.pressure * after) / (GAS_CONSTANT * INTAKE_TEMPERATURE)
          const fuel = this.firing ? cylinder.mass / (1 + AIR_FUEL_RATIO) : 0
          cylinder.heat = fuel * FUEL_ENERGY * HEAT_KEPT
          // Like any ignition system, hold the spark back at cranking speed so the engine cannot kick backwards.
          cylinder.spark = 360 - Math.min(params.advance, 4 + rpm / 40)
          this.fuelPerCycle += (fuel - this.fuelPerCycle) * Math.min(1, 2 / count)
        }
      } else if (to <= EXHAUST_OPENS) {
        // Valves shut: compression and expansion follow the gas law, plus whatever burned this step.
        const burned = cylinder.heat * (this.burned(to, cylinder.spark) - this.burned(from, cylinder.spark))
        cylinder.pressure = cylinder.pressure * Math.pow(before / after, GAMMA) + ((GAMMA - 1) * burned) / after
        if (cylinder.mass > 0) cylinder.temperature = (cylinder.pressure * after) / (cylinder.mass * GAS_CONSTANT)
      } else {
        // Exhaust valve open: pressure blows down, then the piston pushes the rest out.
        const ease = 1 - Math.exp(-turned / (from < 540 ? 25 : 10))
        cylinder.pressure += (P_EXHAUST - cylinder.pressure) * ease
        cylinder.temperature += (750 - cylinder.temperature) * ease * 0.5
      }
      // Slow leakage past the rings, which is what lets a stopped engine settle.
      cylinder.pressure += (P_ATM - cylinder.pressure) * (1 - Math.exp(-dt / 2))

      torque += ((start + cylinder.pressure) / 2 - P_ATM) * leverage(from + turned / 2)
      if (index === 0) {
        for (let degree = Math.floor(from); degree <= Math.floor(to); degree++) {
          this.tracePressure[degree % 720] = cylinder.pressure
          this.traceTemperature[degree % 720] = cylinder.temperature
        }
      }
    })

    const friction = count * (3.2 + 0.0011 * rpm)
    // The brake is let in gradually once the engine is running, as a clutch would be.
    this.clutch = this.status === 'running' ? Math.min(1, this.clutch + dt / 1.5) : 0
    const brake = params.load * (0.5 + (0.5 * rpm) / 3000) * Math.min(1, rpm / 300) * this.clutch
    const starter = this.status === 'cranking' ? 90 * Math.max(0, 1 - rpm / 450) : 0
    const inertia = 0.12 + 0.02 * count
    let net = torque + starter
    // Friction and the brake oppose motion; they can stop the crank but never drive it backwards.
    const drag = friction + brake
    if (this.speed > 0 || Math.abs(net) > drag) net -= Math.sign(this.speed || net) * drag
    else net = 0
    const next = this.speed + (net / inertia) * dt
    this.speed = this.speed > 0 && next < 0 ? 0 : Math.max(0, next)
    this.torque += (((this.speed > 0 ? torque - friction : 0) - this.torque) * dt) / 0.3
    if (this.speed < 1) this.ripple = 0

    this.slowest = Math.min(this.slowest, this.speed)
    this.fastest = Math.max(this.fastest, this.speed)
    const angle = this.angle + turned
    if (angle >= 720) {
      const mean = (this.slowest + this.fastest) / 2
      this.ripple = mean > 1 ? (this.fastest - this.slowest) / mean : 0
      this.slowest = Infinity
      this.fastest = 0
    }
    this.angle = angle % 720
  }

  /** Fraction of the charge burned by a given crank angle: slow to start, fast in the middle, tailing off. */
  private burned(angle: number, spark: number): number {
    if (angle <= spark) return 0
    return 1 - Math.exp(-5 * Math.pow((angle - spark) / BURN_DURATION, 3))
  }
}
