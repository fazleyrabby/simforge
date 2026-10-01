import type { Rng } from '../core/random'

export type BodyStyle = 'hatch' | 'sedan' | 'coupe'

export interface VehicleSpec {
  name: string
  body: BodyStyle
  color: number
  /** kg */
  mass: number
  /** N·m */
  peakTorque: number
  idleRpm: number
  redline: number
  gears: number[]
  finalDrive: number
  /** m */
  wheelRadius: number
  /** Drag coefficient × frontal area, m². */
  dragArea: number
  drivenAxle: 'front' | 'rear'
}

export interface DynoParams {
  mode: 'cycle' | 'manual'
  /** 0..1, used in manual mode. */
  throttle: number
  /** Simulated road incline in percent. */
  grade: number
  /** Friction coefficient between tyre and roller. */
  grip: number
  /** Fan airspeed added to road speed, m/s. */
  wind: number
}

export interface PowerRunResult {
  peakPower: number
  peakRpm: number
}

const GRAVITY = 9.81
const AIR_DENSITY = 1.2
const ROLLING_RESISTANCE = 0.012
const DRIVELINE_EFFICIENCY = 0.9
/** Share of the car's weight on the driven axle. */
const DRIVEN_WEIGHT = 0.55
/** Rotating inertia of driven wheels and driveline, as an equivalent mass in kg. */
const WHEEL_INERTIA = 70
/** Slip ratio at which the tyre reaches peak grip. */
const PEAK_SLIP = 0.12
const SUBSTEPS = 8
const SHIFT_TIME = 0.25

const prefixes = ['MK', 'RX', 'TS', 'GT', 'LX', 'VR']
const bodies: BodyStyle[] = ['hatch', 'sedan', 'coupe']

export function generateVehicle(rng: Rng, colors: readonly number[]): VehicleSpec {
  const body = rng.pick(bodies)
  const gearCount = rng.int(5, 6)
  const gears = [rng.range(3.2, 3.8)]
  for (let i = 1; i < gearCount; i++) gears.push(gears[i - 1] * rng.range(0.66, 0.73))
  return {
    name: `${rng.pick(prefixes)}-${rng.int(2, 9)} ${body.toUpperCase()}`,
    body,
    color: rng.pick(colors),
    mass: Math.round(rng.range(950, 1750)),
    peakTorque: Math.round(rng.range(160, 420)),
    idleRpm: 900,
    redline: Math.round(rng.range(6000, 7800) / 100) * 100,
    gears,
    finalDrive: rng.range(3.6, 4.3),
    wheelRadius: rng.range(0.3, 0.34),
    dragArea: rng.range(0.58, 0.82),
    drivenAxle: rng.chance(0.5) ? 'front' : 'rear',
  }
}

/** Full-throttle engine torque: a parabola peaking at 62% of the redline. */
export function engineTorque(spec: VehicleSpec, rpm: number): number {
  const peakRpm = spec.redline * 0.62
  const falloff = (rpm - peakRpm) / peakRpm
  return spec.peakTorque * Math.max(0.3, 1 - 0.6 * falloff * falloff)
}

interface CycleSegment {
  /** Seconds spent ramping to this speed, then holding it. */
  ramp: number
  hold: number
  /** m/s */
  speed: number
}

/** A seeded test schedule of speeds to hit, like an emissions drive cycle. */
export function generateCycle(rng: Rng): CycleSegment[] {
  const segments: CycleSegment[] = []
  const count = rng.int(7, 9)
  for (let i = 0; i < count; i++) {
    const stop = i === count - 1 || rng.chance(0.18)
    segments.push({
      ramp: rng.range(4, 7),
      hold: rng.range(3.5, 7),
      speed: stop ? 0 : rng.range(30, 130) / 3.6,
    })
  }
  return segments
}

/**
 * A car on a chassis dynamometer, independent of rendering.
 *
 * Two bodies are simulated: the driven wheels (spun by the engine through the
 * gearbox) and the rollers (which carry the simulated road load: rolling
 * resistance, aerodynamic drag, incline and the car's own inertia). They are
 * coupled only by tyre friction, so too much torque for the available grip
 * makes the wheels spin faster than the rollers.
 */
export class DynoLogic {
  /** Tyre surface speed, m/s. */
  wheelSpeed = 0
  /** Roller surface speed, m/s: the "road speed" of the test. */
  rollerSpeed = 0
  rpm: number
  gear = 0
  /** Applied throttle and brake, 0..1. */
  throttle = 0
  brake = 0
  time = 0
  distance = 0
  /** Power delivered to the rollers, W. */
  wheelPower = 0
  /** Engine torque, N·m. */
  torque = 0
  /** Slip ratio between tyre and roller. */
  slip = 0
  /** Roller acceleration, m/s². */
  acceleration = 0
  peakPower = 0
  peakRpm = 0
  powerRun = false
  onPowerRunEnd: ((result: PowerRunResult) => void) | null = null

  private shiftTimer = 0
  private shiftLock = 0
  private integral = 0
  private lastTarget = 0
  private runTime = 0
  private cycleLength: number

  constructor(
    readonly vehicle: VehicleSpec,
    readonly cycle: CycleSegment[],
    public params: DynoParams,
  ) {
    this.rpm = vehicle.idleRpm
    this.cycleLength = cycle.reduce((total, segment) => total + segment.ramp + segment.hold, 0)
  }

  /** Speed the drive cycle asks for at the current time, m/s. */
  targetSpeed(): number {
    let t = this.time % this.cycleLength
    let previous = this.cycle[this.cycle.length - 1].speed
    for (const segment of this.cycle) {
      if (t < segment.ramp) {
        const blend = t / segment.ramp
        return previous + (segment.speed - previous) * blend * blend * (3 - 2 * blend)
      }
      t -= segment.ramp
      if (t < segment.hold) return segment.speed
      t -= segment.hold
      previous = segment.speed
    }
    return previous
  }

  /** Road load the rollers apply at a given speed, N. */
  roadLoad(speed: number): number {
    const { mass, dragArea } = this.vehicle
    const air = speed + this.params.wind
    return mass * GRAVITY * (ROLLING_RESISTANCE + this.params.grade / 100) + 0.5 * AIR_DENSITY * dragArea * air * air
  }

  /** Begins a full-throttle pull that records peak power. */
  startPowerRun(): void {
    this.powerRun = true
    this.runTime = 0
    this.peakPower = 0
    this.peakRpm = 0
  }

  step(dt: number): void {
    this.time += dt
    this.drive(dt)
    this.shift(dt)

    const startSpeed = this.rollerSpeed
    const h = dt / SUBSTEPS
    for (let i = 0; i < SUBSTEPS; i++) this.integrate(h)
    this.acceleration = (this.rollerSpeed - startSpeed) / dt
    this.distance += this.rollerSpeed * dt

    if (this.powerRun) {
      this.runTime += dt
      if (this.wheelPower > this.peakPower) {
        this.peakPower = this.wheelPower
        this.peakRpm = this.rpm
      }
      const topGear = this.gear === this.vehicle.gears.length - 1
      if (this.runTime > 16 || (topGear && this.rpm > this.vehicle.redline * 0.97)) {
        this.powerRun = false
        this.onPowerRunEnd?.({ peakPower: this.peakPower, peakRpm: this.peakRpm })
      }
    }
  }

  /** The driver: full throttle on a power run, a PI controller on the cycle, the slider otherwise. */
  private drive(dt: number): void {
    let throttle = this.params.throttle
    let brake = 0
    if (this.powerRun) {
      throttle = 1
    } else if (this.params.mode === 'cycle') {
      const target = this.targetSpeed()
      const error = target - this.rollerSpeed
      // Feedforward: the throttle that would hold the target speed and its rate of change.
      const { vehicle } = this
      const demand = this.roadLoad(target) + (vehicle.mass * (target - this.lastTarget)) / dt
      this.lastTarget = target
      const available =
        (engineTorque(vehicle, this.rpm) * vehicle.gears[this.gear] * vehicle.finalDrive * DRIVELINE_EFFICIENCY) /
        vehicle.wheelRadius
      this.integral = Math.max(-4, Math.min(8, this.integral + error * dt))
      throttle = Math.max(0, Math.min(1, demand / available + 0.22 * error + 0.09 * this.integral))
      if (error < -1) brake = Math.min(1, (-error - 1) * 0.25)
    }
    const response = Math.min(1, dt * 6)
    this.throttle += (throttle - this.throttle) * response
    this.brake += (brake - this.brake) * response
  }

  private shift(dt: number): void {
    const { vehicle } = this
    this.shiftTimer = Math.max(0, this.shiftTimer - dt)
    this.shiftLock = Math.max(0, this.shiftLock - dt)
    if (this.shiftLock > 0) return
    // Shift points rise with throttle: early for economy, late for power.
    const up = vehicle.redline * (0.42 + 0.51 * this.throttle)
    const down = vehicle.redline * (0.2 + 0.3 * this.throttle)
    if (this.rpm > up && this.gear < vehicle.gears.length - 1) this.changeGear(this.gear + 1)
    else if (this.rpm < down && this.gear > 0) this.changeGear(this.gear - 1)
  }

  private changeGear(gear: number): void {
    this.gear = gear
    this.shiftTimer = SHIFT_TIME
    this.shiftLock = 0.7
  }

  private integrate(h: number): void {
    const { vehicle, params } = this
    const ratio = vehicle.gears[this.gear] * vehicle.finalDrive

    // Engine speed follows the wheels; below idle the clutch slips.
    const wheelRpm = (this.wheelSpeed / vehicle.wheelRadius) * (60 / (2 * Math.PI)) * ratio
    this.rpm = Math.max(vehicle.idleRpm, wheelRpm)

    let torque = 0
    if (this.shiftTimer <= 0 && this.rpm < vehicle.redline) {
      const engineBraking = wheelRpm > vehicle.idleRpm ? vehicle.peakTorque * 0.09 * (1 - this.throttle) * (this.rpm / vehicle.redline) : 0
      torque = engineTorque(vehicle, this.rpm) * this.throttle - engineBraking
    }
    this.torque = torque
    const driveForce = (torque * ratio * DRIVELINE_EFFICIENCY) / vehicle.wheelRadius

    const normalForce = vehicle.mass * GRAVITY * DRIVEN_WEIGHT
    const reference = Math.max(Math.abs(this.wheelSpeed), Math.abs(this.rollerSpeed), 1.5)
    this.slip = (this.wheelSpeed - this.rollerSpeed) / reference
    const tyreForce = params.grip * normalForce * Math.max(-1, Math.min(1, this.slip / PEAK_SLIP))

    const brakeForce = this.wheelSpeed > 0.05 ? this.brake * normalForce * 0.9 : 0
    this.wheelSpeed = Math.max(0, this.wheelSpeed + ((driveForce - brakeForce - tyreForce) / WHEEL_INERTIA) * h)

    // The rollers never turn backwards: the load only resists motion.
    const load = this.roadLoad(this.rollerSpeed)
    const net = tyreForce - (this.rollerSpeed > 0 || tyreForce > load ? load : tyreForce)
    this.rollerSpeed = Math.max(0, this.rollerSpeed + (net / vehicle.mass) * h)
    this.wheelPower = Math.max(0, tyreForce * this.rollerSpeed)
  }
}
