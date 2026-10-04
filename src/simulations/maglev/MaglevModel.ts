export interface MaglevParams {
  mode: 'auto' | 'manual'
  target: number
  current: number
  gain: number
  mass: number
}

const GRAVITY = 9.81
const MAGNET_STRENGTH = 0.22
const FIELD_SOFTENING = 0.12
const MAX_CURRENT = 4.5
const COIL_RESPONSE = 0.085
const MIN_GAP = 0.27
const MAX_GAP = 2.18

/** A levitated steel ball beneath an electromagnet, measured in SI units. */
export class MaglevModel {
  gap: number
  velocity = 0
  current = 0
  command = 0
  force = 0
  temperature = 22
  time = 0
  catches = 0
  peakError = 0
  private integral = 0

  constructor(public params: MaglevParams) {
    this.gap = params.target + 0.06
    this.current = this.equilibriumCurrent(this.gap)
    this.command = this.current
    this.force = this.magneticForce(this.gap, this.current)
  }

  get error(): number { return this.gap - this.params.target }
  get acceleration(): number { return GRAVITY - this.force / this.params.mass }
  get status(): string {
    if (this.gap >= MAX_GAP - 0.005) return 'CAUGHT'
    if (this.gap <= MIN_GAP + 0.005) return 'CONTACT'
    if (this.params.mode === 'manual') return 'OPEN LOOP'
    return Math.abs(this.error) < 0.055 && Math.abs(this.velocity) < 0.18 ? 'STABLE' : 'CORRECTING'
  }

  step(dt: number): void {
    const h = dt / 4
    for (let n = 0; n < 4; n++) {
      if (this.params.mode === 'auto') {
        const kp = 21 * this.params.gain
        const kd = 6.5 * Math.sqrt(this.params.gain)
        const ki = 7 * this.params.gain
        this.integral = Math.max(-0.2, Math.min(0.2, this.integral + this.error * h))
        const wantedForce = Math.max(0, this.params.mass * (
          GRAVITY + kp * this.error + kd * this.velocity + ki * this.integral
        ))
        this.command = Math.min(MAX_CURRENT, Math.sqrt(wantedForce / MAGNET_STRENGTH) * (this.gap + FIELD_SOFTENING))
      } else {
        this.integral = 0
        this.command = Math.min(MAX_CURRENT, Math.max(0, this.params.current))
      }
      // Finite coil response makes abrupt commands and unstable manual settings visible.
      this.current += (this.command - this.current) * (1 - Math.exp(-h / COIL_RESPONSE))
      this.force = this.magneticForce(this.gap, this.current)
      this.velocity += (GRAVITY - this.force / this.params.mass) * h
      this.gap += this.velocity * h
      if (this.gap < MIN_GAP) {
        this.gap = MIN_GAP
        this.velocity = Math.max(0, -this.velocity * 0.18)
      } else if (this.gap > MAX_GAP) {
        this.gap = MAX_GAP
        if (this.velocity > 0.05) this.catches++
        this.velocity = Math.min(0, -this.velocity * 0.22)
      }
      this.temperature += (0.95 * this.current ** 2 - 0.075 * (this.temperature - 22)) * h
      this.time += h
    }
    this.peakError = Math.max(this.peakError, Math.abs(this.error))
  }

  nudge(): void {
    this.velocity += 0.72
  }

  reset(): void {
    this.gap = this.params.target + 0.06
    this.velocity = 0
    this.current = this.equilibriumCurrent(this.gap)
    this.command = this.current
    this.force = this.magneticForce(this.gap, this.current)
    this.temperature = 22
    this.time = 0
    this.catches = 0
    this.peakError = 0
    this.integral = 0
  }

  private equilibriumCurrent(gap: number): number {
    return Math.min(MAX_CURRENT, (gap + FIELD_SOFTENING) * Math.sqrt(this.params.mass * GRAVITY / MAGNET_STRENGTH))
  }

  private magneticForce(gap: number, current: number): number {
    return MAGNET_STRENGTH * current * current / (gap + FIELD_SOFTENING) ** 2
  }
}
