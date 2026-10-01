import { Rng } from '../core/random'

export type ObjectBehavior = 'rigid' | 'ductile' | 'elastic' | 'brittle'

export interface PressObjectDef {
  id: string
  name: string
  description: string
  behavior: ObjectBehavior
  H: number
  halfWidth: number
  halfDepth: number
  failMessage?: string
  // Material parameters
  stiffness?: number
  yield?: number
  hardening?: number
  densify?: number
  maxCompression?: number
  springBack?: number
  bounce?: number
  strength?: number
  breakStrain?: number
  fragments?: number
  fragmentShape?: 'shard' | 'chunk'
  dustColor?: [number, number, number]
  bulge?: number
  crumple?: number
  folds?: number
}

export const PRESS_OBJECT_DEFS: Record<string, PressObjectDef> = {
  nokia3310: {
    id: 'nokia3310',
    name: 'Nokia 3310',
    description: 'Built in 2000. Rated for drops, floods, and apparently hydraulic presses.',
    behavior: 'rigid',
    stiffness: 1e7,
    H: 4.8,
    halfWidth: 5.65,
    halfDepth: 1.1,
    failMessage: 'Nokia 3310: 1 — Hydraulic press: 0',
  },
  sodaCan: {
    id: 'sodaCan',
    name: 'Soda Can',
    description: 'Thin aluminium. Yields almost instantly and crumples.',
    behavior: 'ductile',
    yield: 0.12,
    hardening: 1.2,
    densify: 30,
    maxCompression: 0.84,
    bulge: 0.3,
    crumple: 0.35,
    folds: 6,
    springBack: 0.03,
    H: 12.2,
    halfWidth: 3.3,
    halfDepth: 3.3,
  },
  rubberBall: {
    id: 'rubberBall',
    name: 'Rubber Ball',
    description: 'Squishes flat, bounces right back. Nothing to break.',
    behavior: 'elastic',
    stiffness: 1.8,
    maxCompression: 0.62,
    bounce: 1,
    H: 7.2,
    halfWidth: 3.6,
    halfDepth: 3.6,
  },
  glassCube: {
    id: 'glassCube',
    name: 'Glass Cube',
    description: 'Hard but brittle. Holds until ~6 t, then explodes into shards.',
    behavior: 'brittle',
    strength: 6,
    breakStrain: 0.015,
    fragments: 60,
    fragmentShape: 'shard',
    dustColor: [0.9, 0.95, 1],
    H: 5.5,
    halfWidth: 2.75,
    halfDepth: 2.75,
  },
  tungstenCube: {
    id: 'tungstenCube',
    name: 'Tungsten Cube',
    description: 'Very dense, yields around 250 t. Needs a big press — or it wins.',
    behavior: 'ductile',
    yield: 250,
    hardening: 0.4,
    densify: 2,
    maxCompression: 0.45,
    bulge: 0.45,
    crumple: 0.03,
    folds: 1,
    springBack: 0.03,
    failMessage: 'Tungsten Cube held — try raising the press capacity above 250 t',
    H: 5.0,
    halfWidth: 2.5,
    halfDepth: 2.5,
  },
}

export type PressState = 'idle' | 'descend' | 'load' | 'follow' | 'hold' | 'retract' | 'strain' | 'failed'

export interface OutcomeInfo {
  head: string
  sub: string
  cls: 'ok' | 'warn' | 'danger'
}

export interface PressLogicEvent {
  type: 'contact' | 'crunch' | 'shatter' | 'boing' | 'strain_start' | 'bolt_pop' | 'explode' | 'landed' | 'complete'
  detail?: string
}

export const FREE_SPEED = 10     // cm/s ram travel without load
export const LOAD_SPEED = 3.5    // cm/s max ram travel under load
export const RETRACT_SPEED = 12  // cm/s
export const RAMP_TIME = 2.6     // s to build full pressure
export const STALL_TIME = 0.5    // s at full pressure without progress before strain
export const STRAIN_TIME = 3.4   // s of overload before catastrophic failure
export const MIN_GAP = 0.4       // cm closest plate-to-anvil approach

export class PressLogic {
  readonly anvilTop = 12
  readonly baseTop = 4
  readonly restY = 27 // anvilTop + 15

  state: PressState = 'idle'
  ramY = 27
  force = 0
  pressure = 0
  compression = 0
  cMax = 0
  stall = 0
  holdT = 0
  strainT = 0
  t = 0
  broken = false
  pressExploded = false
  outcome: OutcomeInfo | null = null
  statusHead = 'READY'
  statusSub = ''
  statusCls: 'ok' | 'warn' | 'danger' | '' = ''

  boltsPopped = 0
  private elasticV = 0
  private objectDef: PressObjectDef
  private capacity: number
  private rng: Rng
  private eventsQueue: PressLogicEvent[] = []

  // Object drop state when press explodes
  dropping: { vy: number; phase: 'fall' | 'tip' | 'rest'; ang: number; w: number; y: number; ground: number; landed: boolean } | null = null

  constructor(objectDef: PressObjectDef, capacity = 100, seed = 1) {
    this.objectDef = objectDef
    this.capacity = capacity
    this.rng = new Rng(seed)
    this.reset()
  }

  get object(): PressObjectDef {
    return this.objectDef
  }

  get busy(): boolean {
    return this.state !== 'idle' && this.state !== 'failed'
  }

  get strainProgress(): number {
    return this.state === 'strain' ? Math.min(1, this.strainT / STRAIN_TIME) : 0
  }

  get targetCompression(): number {
    const o = this.objectDef
    switch (o.behavior) {
      case 'rigid': return 1
      case 'brittle': return o.breakStrain ?? 0.02
      default: return o.maxCompression ?? 0.8
    }
  }

  get requiredForce(): number {
    const o = this.objectDef
    if (o.behavior === 'rigid') return Infinity
    if (o.behavior === 'brittle') return o.strength ?? 5
    if (o.behavior === 'ductile') return o.yield ?? 1
    return this.forceAt(this.targetCompression)
  }

  get topY(): number {
    if (this.broken) return this.anvilTop
    return this.anvilTop + this.objectDef.H * (1 - Math.max(0, this.compression))
  }

  setCapacity(capacity: number): void {
    this.capacity = capacity
    if (this.state === 'idle') {
      this.statusHead = 'READY'
      this.statusSub = `${this.objectDef.name} vs ${this.capacity} t press`
      this.statusCls = ''
    }
  }

  setObject(def: PressObjectDef): void {
    this.objectDef = def
    this.reset()
  }

  reset(): void {
    this.state = 'idle'
    this.ramY = this.restY
    this.force = 0
    this.pressure = 0
    this.compression = 0
    this.cMax = 0
    this.stall = 0
    this.holdT = 0
    this.strainT = 0
    this.t = 0
    this.elasticV = 0
    this.broken = false
    this.pressExploded = false
    this.outcome = null
    this.boltsPopped = 0
    this.dropping = null
    this.statusHead = 'READY'
    this.statusSub = `${this.objectDef.name} vs ${this.capacity} t press`
    this.statusCls = ''
    this.eventsQueue = []
  }

  start(): void {
    if (this.state !== 'idle') return
    this.state = 'descend'
    this.statusHead = 'DESCENDING'
    this.statusSub = `${this.objectDef.name} under ${this.capacity} t`
    this.statusCls = ''
  }

  pollEvents(): PressLogicEvent[] {
    const events = this.eventsQueue
    this.eventsQueue = []
    return events
  }

  forceAt(c: number): number {
    const o = this.objectDef
    switch (o.behavior) {
      case 'rigid':
        return (o.stiffness ?? 1e7) * c
      case 'elastic':
        return (o.stiffness ?? 2) * Math.pow(Math.max(c, 0), 1.6)
      case 'brittle':
        return ((o.strength ?? 5) * c) / (o.breakStrain ?? 0.02)
      case 'ductile': {
        const yieldVal = o.yield ?? 1
        const cy = 0.015
        if (c < cy) return (yieldVal * c) / cy
        const hardening = o.hardening ?? 0.8
        const densify = o.densify ?? 6
        return (
          yieldVal * (1 + hardening * (c - cy)) +
          yieldVal * densify * Math.pow(Math.max(0, c - 0.75) / 0.25, 3)
        )
      }
    }
  }

  /** Largest compression sustainable under hydraulic pressure P (monotonic bisection). */
  private solve(P: number, lo: number, hi: number): number {
    if (this.forceAt(hi) <= P) return hi
    if (this.forceAt(lo) > P) return lo
    let l = lo
    let h = hi
    for (let i = 0; i < 40; i++) {
      const mid = (l + h) / 2
      if (this.forceAt(mid) <= P) l = mid
      else h = mid
    }
    return l
  }

  step(dt: number): void {
    this.t += dt
    const o = this.objectDef
    const top = this.anvilTop
    const H = o.H
    let y = this.ramY

    switch (this.state) {
      case 'descend': {
        y -= FREE_SPEED * dt
        const contact = this.broken ? top + MIN_GAP : this.topY
        if (y <= contact) {
          y = contact
          this.state = this.broken ? 'hold' : 'load'
          this.pressure = 0
          this.stall = 0
          this.holdT = 0
          this.eventsQueue.push({ type: 'contact' })
        }
        break
      }

      case 'load': {
        this.pressure = Math.min(this.capacity, this.pressure + (this.capacity / RAMP_TIME) * dt)
        const target = this.targetCompression
        const cStar = this.solve(this.pressure, this.compression, target)
        const cNext = Math.min(cStar, this.compression + (LOAD_SPEED * dt) / H)
        const advancing = cNext - this.compression > 1e-7
        if (cNext > this.compression) {
          this.compression = cNext
          this.cMax = Math.max(this.cMax, cNext)
        }
        this.force = this.forceAt(this.compression)
        y = top + H * (1 - this.compression)

        if (o.behavior === 'ductile' && advancing && this.rng.next() < dt * 14) {
          this.eventsQueue.push({ type: 'crunch' })
        }
        this.statusHead = 'LOADING'
        this.statusSub = `${this.force.toFixed(this.force < 10 ? 2 : 1)} t`
        this.statusCls = ''

        if (this.compression >= target - 1e-6) {
          if (o.behavior === 'brittle') {
            this.broken = true
            this.eventsQueue.push({ type: 'shatter' })
            this.outcome = {
              head: 'SHATTERED',
              sub: `${o.name} gave up at ${this.force.toFixed(1)} t`,
              cls: 'ok',
            }
            this.force = 0
            this.state = 'follow'
          } else {
            this.state = 'hold'
            this.holdT = 0
            this.outcome =
              o.behavior === 'elastic'
                ? { head: 'BOING', sub: `${o.name} squished ${(this.compression * 100).toFixed(0)}% and bounced back`, cls: 'ok' }
                : { head: 'CRUSHED', sub: `${o.name} flattened by ${(this.compression * 100).toFixed(0)}%`, cls: 'ok' }
          }
        } else if (this.pressure >= this.capacity && !advancing) {
          this.stall += dt
          if (this.stall > STALL_TIME) {
            this.state = 'strain'
            this.strainT = 0
            this.eventsQueue.push({ type: 'strain_start' })
          }
        } else {
          this.stall = 0
        }
        break
      }

      case 'follow': {
        y -= FREE_SPEED * 1.5 * dt
        if (y <= top + MIN_GAP) {
          y = top + MIN_GAP
          this.state = 'hold'
          this.holdT = 0
          this.eventsQueue.push({ type: 'contact' })
        }
        break
      }

      case 'hold': {
        this.holdT += dt
        if (this.holdT > 0.9) {
          this.state = 'retract'
          if (o.behavior === 'elastic') {
            this.eventsQueue.push({ type: 'boing' })
          }
          if (this.outcome) {
            this.statusHead = this.outcome.head
            this.statusSub = this.outcome.sub
            this.statusCls = this.outcome.cls
          }
        }
        break
      }

      case 'retract': {
        this.force = Math.max(0, this.force - this.capacity * dt)
        y += RETRACT_SPEED * dt
        if (y >= this.restY) {
          y = this.restY
          this.state = 'idle'
          if (!this.outcome) {
            this.statusHead = 'READY'
            this.statusSub = `${o.name} vs ${this.capacity} t press`
            this.statusCls = ''
          }
          this.eventsQueue.push({ type: 'complete' })
        }
        break
      }

      case 'strain': {
        this.strainT += dt
        const k = Math.min(1, this.strainT / STRAIN_TIME)
        this.force = this.capacity * (1 + 0.1 * k + Math.sin(this.t * 40) * 0.015 * (1 + k * 3))
        this.statusHead = '⚠ OVERLOAD'
        this.statusSub = `${this.force.toFixed(0)} t / ${this.capacity} t — ${o.name} is not moving`
        this.statusCls = 'warn'

        const popAt = [0.72, 0.86]
        if (this.boltsPopped < popAt.length && k > popAt[this.boltsPopped]) {
          this.boltsPopped++
          this.eventsQueue.push({ type: 'bolt_pop' })
        }

        if (k >= 1) {
          this.pressExploded = true
          this.state = 'failed'
          this.force = 0
          this.eventsQueue.push({ type: 'explode' })
          this.statusHead = '✖ PRESS DESTROYED'
          this.statusSub = o.failMessage || `${o.name} was stronger than ${this.capacity} t`
          this.statusCls = 'danger'
          this.dropping = {
            vy: 60,
            phase: 'fall',
            ang: 0,
            w: 0,
            y: this.anvilTop,
            ground: this.baseTop,
            landed: false,
          }
        }
        break
      }

      case 'failed':
        break
    }

    if (this.state !== 'failed' && this.state !== 'strain') {
      this.ramY = y
    }

    // Object spring-back or relaxation when ram is not actively loading
    const free = !['load', 'hold'].includes(this.state) || this.broken
    const gap = this.ramY - top
    if (!this.broken && free) {
      const plateC = 1 - gap / H
      if (o.behavior === 'elastic') {
        const k = 350 * (o.bounce ?? 1)
        const d = 9
        this.elasticV += (-k * this.compression - d * this.elasticV) * dt
        let c = this.compression + this.elasticV * dt
        if (c < plateC) {
          c = plateC
          this.elasticV = Math.max(this.elasticV, 0)
        }
        if (Math.abs(c) > 1e-4 || Math.abs(this.elasticV) > 1e-3) {
          this.compression = c
        }
      } else if (o.behavior === 'ductile') {
        const rest = Math.max(0, this.cMax - (o.springBack ?? 0.03))
        const target = Math.max(rest, plateC)
        if (Math.abs(this.compression - target) > 1e-4) {
          const cm = this.cMax
          this.compression = this.compression + (target - this.compression) * Math.min(1, dt * 10)
          this.cMax = cm
        }
      }
    }

    // Drop animation when press fails
    if (this.dropping) {
      const d = this.dropping
      if (d.phase === 'fall') {
        d.vy -= 981 * dt
        d.y += d.vy * dt
        if (d.y <= d.ground) {
          d.y = d.ground
          if (Math.abs(d.vy) > 60) {
            d.vy = -d.vy * 0.25
          } else {
            d.phase = o.H > o.halfDepth * 2 * 1.3 ? 'tip' : 'rest'
          }
        }
      } else if (d.phase === 'tip') {
        d.w += 18 * Math.sin(d.ang + 0.15) * dt
        d.ang += d.w * dt
        if (d.ang >= Math.PI / 2) {
          d.ang = Math.PI / 2
          if (d.w > 0.8) {
            d.w = -d.w * 0.25
          } else {
            d.phase = 'rest'
          }
        }
      } else if (d.phase === 'rest' && !d.landed) {
        d.landed = true
        this.eventsQueue.push({ type: 'landed' })
      }
    }
  }
}
