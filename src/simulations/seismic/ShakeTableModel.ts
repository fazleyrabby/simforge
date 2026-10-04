export interface ShakeParams {
  frequency: number
  amplitude: number
  damping: number
  damper: boolean
  tuning: number
}

/** Three-storey shear building, with an optional tuned mass on the roof.
 * Coordinates are relative to the moving table; metres, seconds and unit floor masses.
 */
export class ShakeTableModel {
  params: ShakeParams
  readonly floors = [0, 0, 0]
  readonly velocities = [0, 0, 0]
  damperX = 0
  damperV = 0
  time = 0
  peakRoof = 0
  peakAcceleration = 0
  peakStoryDrift = 0
  private phase = 0
  private state = new Float64Array(8)

  constructor(params: ShakeParams) { this.params = params }

  get baseX(): number { return this.params.amplitude * Math.sin(this.phase) }
  get roofX(): number { return this.baseX + this.floors[2] }
  get naturalFrequency(): number { return Math.sqrt(STOREY_STIFFNESS) * 0.44504 / (2 * Math.PI) }
  get frequencyRatio(): number { return this.params.frequency / this.naturalFrequency }
  get damperTravel(): number { return this.params.damper ? this.damperX - this.floors[2] : 0 }

  step(dt: number): void {
    // Four RK4 substeps keep the roof and damper stable even at the highest tuning.
    const h = dt / 4
    for (let n = 0; n < 4; n++) {
      const omega = 2 * Math.PI * this.params.frequency
      const phase0 = this.phase
      const k1 = this.derivative(this.state, phase0)
      const k2 = this.derivative(this.offset(this.state, k1, h / 2), phase0 + omega * h / 2)
      const k3 = this.derivative(this.offset(this.state, k2, h / 2), phase0 + omega * h / 2)
      const k4 = this.derivative(this.offset(this.state, k3, h), phase0 + omega * h)
      for (let i = 0; i < 8; i++) this.state[i] += h * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) / 6
      this.phase += omega * h
      this.time += h
    }
    for (let i = 0; i < 3; i++) {
      this.floors[i] = this.state[i]
      this.velocities[i] = this.state[i + 3]
    }
    this.damperX = this.state[6]
    this.damperV = this.state[7]
    this.peakRoof = Math.max(this.peakRoof, Math.abs(this.floors[2]))
    this.peakStoryDrift = Math.max(
      this.peakStoryDrift,
      Math.abs(this.floors[0]),
      Math.abs(this.floors[1] - this.floors[0]),
      Math.abs(this.floors[2] - this.floors[1]),
    )
    const acceleration = this.derivative(this.state, this.phase)[5] + this.baseAcceleration(this.phase)
    this.peakAcceleration = Math.max(this.peakAcceleration, Math.abs(acceleration))
  }

  reset(): void {
    this.state.fill(0)
    this.floors.fill(0)
    this.velocities.fill(0)
    this.damperX = 0
    this.damperV = 0
    this.phase = 0
    this.time = 0
    this.peakRoof = 0
    this.peakAcceleration = 0
    this.peakStoryDrift = 0
  }

  private baseAcceleration(phase: number): number {
    const omega = 2 * Math.PI * this.params.frequency
    return -this.params.amplitude * omega * omega * Math.sin(phase)
  }

  private offset(state: Float64Array, derivative: Float64Array, h: number): Float64Array {
    const result = new Float64Array(8)
    for (let i = 0; i < 8; i++) result[i] = state[i] + h * derivative[i]
    return result
  }

  private derivative(s: Float64Array, phase: number): Float64Array {
    const out = new Float64Array(8)
    const k = STOREY_STIFFNESS
    const c = 2 * (this.params.damping / 100) * Math.sqrt(k)
    const groundA = this.baseAcceleration(phase)
    for (let i = 0; i < 3; i++) {
      const belowX = i === 0 ? 0 : s[i - 1]
      const belowV = i === 0 ? 0 : s[i + 2]
      let force = -k * (s[i] - belowX) - c * (s[i + 3] - belowV)
      if (i < 2) force += k * (s[i + 1] - s[i]) + c * (s[i + 4] - s[i + 3])
      out[i] = s[i + 3]
      out[i + 3] = force - groundA
    }
    out[6] = s[7]
    if (this.params.damper) {
      const targetOmega = 2 * Math.PI * this.naturalFrequency * this.params.tuning
      const kd = DAMPER_MASS * targetOmega * targetOmega
      const cd = 2 * 0.12 * DAMPER_MASS * targetOmega
      const force = kd * (s[6] - s[2]) + cd * (s[7] - s[5])
      out[5] += force
      out[7] = -force / DAMPER_MASS - groundA
    } else {
      out[7] = out[5]
    }
    return out
  }
}

const STOREY_STIFFNESS = 200
const DAMPER_MASS = 0.18
