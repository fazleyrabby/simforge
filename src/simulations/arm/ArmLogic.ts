import type { Rng } from '../core/random'

/** Link lengths of the arm, in metres. The tool always points straight down. */
export const ARM = {
  /** Height of the shoulder axis above the floor. */
  shoulderHeight: 1.1,
  upper: 2.3,
  fore: 2.1,
  /** Wrist axis to the tip of the gripper. */
  tool: 0.7,
}

/** Joint order: base yaw, shoulder, elbow, wrist. */
export type Joints = [number, number, number, number]
export type Point = [number, number, number]

/** Peak speed (rad/s) and acceleration (rad/s²) of each joint at 100% speed. */
export const JOINT_SPEED = [4.4, 3.4, 4.4, 6]
const JOINT_ACCEL = [15, 11, 15, 22]
const LINEAR_SPEED = 3.4
const LINEAR_ACCEL = 12
const GRIP_TIME = 0.22

/**
 * Inverse kinematics: joint angles that put the gripper tip at a point.
 *
 * The base turns to face the point, which leaves a two-link problem in the
 * vertical plane through it: shoulder and elbow follow from the law of
 * cosines (taking the elbow-up answer), and the wrist then cancels both so
 * the tool hangs vertically. Returns null when the point is out of reach.
 */
export function solveIK(x: number, y: number, z: number): Joints | null {
  const reach = Math.hypot(x, z)
  if (reach < 0.4) return null
  const rise = y + ARM.tool - ARM.shoulderHeight
  const squared = reach * reach + rise * rise
  const distance = Math.sqrt(squared)
  if (distance > ARM.upper + ARM.fore - 1e-6 || distance < Math.abs(ARM.upper - ARM.fore) + 1e-6) return null
  const cosElbow = (squared - ARM.upper * ARM.upper - ARM.fore * ARM.fore) / (2 * ARM.upper * ARM.fore)
  const elbow = -Math.acos(Math.max(-1, Math.min(1, cosElbow)))
  const shoulder = Math.atan2(rise, reach) - Math.atan2(ARM.fore * Math.sin(elbow), ARM.upper + ARM.fore * Math.cos(elbow))
  return [Math.atan2(z, x), shoulder, elbow, -Math.PI / 2 - shoulder - elbow]
}

/** Forward kinematics: where the gripper tip is for a set of joint angles. */
export function forward(joints: readonly number[]): Point {
  const [yaw, shoulder, elbow, wrist] = joints
  const reach =
    ARM.upper * Math.cos(shoulder) + ARM.fore * Math.cos(shoulder + elbow) + ARM.tool * Math.cos(shoulder + elbow + wrist)
  const height =
    ARM.shoulderHeight +
    ARM.upper * Math.sin(shoulder) +
    ARM.fore * Math.sin(shoulder + elbow) +
    ARM.tool * Math.sin(shoulder + elbow + wrist)
  return [reach * Math.cos(yaw), height, reach * Math.sin(yaw)]
}

/** Quintic ease: zero velocity and acceleration at both ends, so joints start and stop without a jerk. */
export function ease(t: number): number {
  return t * t * t * (10 + t * (-15 + 6 * t))
}

/** Shortest duration of an eased move over `distance` that respects a speed and an acceleration limit. */
function moveTime(distance: number, speed: number, accel: number): number {
  // The quintic peaks at 1.875× its mean speed and 5.7735× distance/T² acceleration.
  return Math.max((1.875 * distance) / speed, Math.sqrt((5.7735 * distance) / accel))
}

/** Time for a joint-space move, set by whichever joint needs longest. */
export function jointMoveTime(from: readonly number[], to: readonly number[]): number {
  let time = 0.12
  for (let j = 0; j < 4; j++) time = Math.max(time, moveTime(Math.abs(to[j] - from[j]), JOINT_SPEED[j], JOINT_ACCEL[j]))
  return time
}

export type PartState = 'belt' | 'held' | 'placed' | 'loose'

export interface Part {
  id: number
  /** Index into the bins: which pallet this part belongs on. */
  color: number
  x: number
  y: number
  z: number
  state: PartState
  /** Distance travelled along the belt. */
  s: number
  bin: number
}

export interface Bin {
  x: number
  z: number
  count: number
  /** Seconds until a full pallet has been swapped for an empty one. */
  swap: number
}

export type Phase =
  | 'toPick'
  | 'awaitPart'
  | 'descendPick'
  | 'grip'
  | 'liftPick'
  | 'toPlace'
  | 'descendPlace'
  | 'release'
  | 'liftPlace'
  | 'manual'

export interface ArmParams {
  manual: boolean
  /** 0.25..2: scales every speed and acceleration limit. */
  speed: number
  /** Parts arriving per minute. */
  feedRate: number
  /** Where the operator wants the gripper tip in manual mode. */
  target: Point
}

export const PART_SIZE = 0.5
export const PART_HEIGHT = 0.4
export const BELT_TOP = 0.9
export const BELT_Z = 2.7
export const BELT_START = -7
export const BELT_LENGTH = 7
export const BIN_FLOOR = 0.3
export const SLOTS_PER_LAYER = 6
export const BIN_CAPACITY = 12
const BELT_SPEED = 1.3
const BELT_GAP = 0.72
const HOVER = 0.7
const SWAP_TIME = 1.6

/** Where the gripper tip must be to hold a part resting at the pick point. */
const PICK: Point = [BELT_START + BELT_LENGTH, BELT_TOP + PART_HEIGHT, BELT_Z]
const PICK_HOVER: Point = [PICK[0], PICK[1] + HOVER, PICK[2]]

type Segment =
  | { kind: 'joint'; from: Joints; to: Joints; time: number }
  | { kind: 'line'; from: Point; to: Point; time: number }
  | { kind: 'hold'; time: number }

/**
 * A pick-and-place robot cell, independent of rendering.
 *
 * Parts arrive on a belt and stop at a gate. The arm swings over in a
 * joint-space move, drops straight down in a Cartesian move, grips, lifts, and
 * carries the part to the next free slot on the pallet of its colour. Every
 * move is eased and timed to stay inside each joint's speed and acceleration
 * limits. In manual mode the arm instead follows a target the operator moves.
 */
export class ArmLogic {
  readonly joints: Joints
  /** 1 = gripper open, 0 = closed on a part. */
  grip = 1
  readonly parts: Part[] = []
  readonly bins: Bin[]
  phase: Phase = 'toPick'
  time = 0
  spawned = 0
  placed = 0
  shipped = 0
  missorted = 0
  pallets = 0
  lastCycle = 0
  /** False while the manual target is outside the arm's reach. */
  reachable = true
  /** Largest joint speed right now as a fraction of its limit, for display and sound. */
  effort = 0
  onGrip: ((closing: boolean) => void) | null = null
  onPallet: ((bin: number) => void) | null = null

  private held: Part | null = null
  private segment: Segment | null = null
  private elapsed = 0
  private feedDebt = 0.6
  private nextId = 0
  private cycleStart = 0
  private gripTarget = 1
  private placements: number[] = []
  private previous: Joints

  constructor(
    private rng: Rng,
    public params: ArmParams,
  ) {
    this.bins = [
      // Two pallets flank the pick point and one sits behind the robot.
      { x: -2.7, z: 1.2, count: 0, swap: 0 },
      { x: 0, z: -2.9, count: 0, swap: 0 },
      { x: 2.7, z: 1.2, count: 0, swap: 0 },
    ]
    this.joints = solveIK(...PICK_HOVER)!
    this.previous = [...this.joints]
    this.phase = params.manual ? 'manual' : 'awaitPart'
  }

  get tip(): Point {
    return forward(this.joints)
  }

  get holding(): boolean {
    return this.held !== null
  }

  get beltParts(): Part[] {
    return this.parts.filter((part) => part.state === 'belt').sort((a, b) => b.s - a.s)
  }

  /** Where the gripper tip goes to place the next part on a pallet. */
  slotPosition(bin: number, slot: number): Point {
    const { x, z } = this.bins[bin]
    const layer = Math.floor(slot / SLOTS_PER_LAYER)
    const column = slot % 3
    const row = Math.floor((slot % SLOTS_PER_LAYER) / 3)
    return [x + (column - 1) * 0.62, BIN_FLOOR + (layer + 1) * PART_HEIGHT + layer * 0.02, z + (row - 0.5) * 0.62]
  }

  /** Completed parts per minute over the last minute. */
  throughput(): number {
    const window = Math.min(60, Math.max(this.time, 5))
    return (this.placements.length / window) * 60
  }

  /** Open or close the gripper by hand (manual mode). */
  toggleGrip(): void {
    if (this.phase !== 'manual') return
    if (this.gripTarget === 1) {
      this.gripTarget = 0
      this.closeOnNearestPart()
    } else {
      this.gripTarget = 1
      this.releaseHeld()
    }
    this.onGrip?.(this.gripTarget === 0)
  }

  /** Switches between the automatic cycle and following the operator's target. */
  setManual(manual: boolean): void {
    if (manual === (this.phase === 'manual')) return
    this.segment = null
    this.elapsed = 0
    if (manual) {
      this.phase = 'manual'
      this.gripTarget = this.held ? 0 : 1
    } else {
      // Put down whatever is being carried, then return to the pick point.
      this.releaseHeld()
      this.gripTarget = 1
      this.beginJoint('toPick', PICK_HOVER)
    }
  }

  step(dt: number): void {
    this.time += dt
    this.previous = [...this.joints]
    this.stepBelt(dt)
    this.stepBins(dt)
    if (this.phase === 'manual') this.stepManual(dt)
    else this.stepProgram(dt)
    if (this.held) {
      const [x, y, z] = this.tip
      this.held.x = x
      this.held.y = y - PART_HEIGHT / 2
      this.held.z = z
    }
    let effort = 0
    for (let j = 0; j < 4; j++) {
      effort = Math.max(effort, Math.abs(this.joints[j] - this.previous[j]) / dt / (JOINT_SPEED[j] * this.params.speed))
    }
    this.effort = effort
    while (this.placements.length > 0 && this.placements[0] < this.time - 60) this.placements.shift()
  }

  /** Parts ride the belt until they reach the gate or the part ahead. */
  private stepBelt(dt: number): void {
    this.feedDebt += (dt * this.params.feedRate) / 60
    const belt = this.beltParts
    if (this.feedDebt >= 1) {
      const last = belt[belt.length - 1]
      if (!last || last.s >= BELT_GAP) {
        this.feedDebt -= 1
        const part: Part = {
          id: this.nextId++,
          color: this.rng.int(0, this.bins.length - 1),
          x: BELT_START,
          y: BELT_TOP + PART_HEIGHT / 2,
          z: BELT_Z,
          state: 'belt',
          s: 0,
          bin: -1,
        }
        this.parts.push(part)
        belt.push(part)
        this.spawned++
      } else {
        // The belt is full back to the start; hold the next part rather than stacking it.
        this.feedDebt = 1
      }
    }
    let limit = BELT_LENGTH
    for (const part of belt) {
      part.s = Math.min(limit, part.s + BELT_SPEED * dt)
      part.x = BELT_START + part.s
      limit = part.s - BELT_GAP
    }
  }

  private stepBins(dt: number): void {
    this.bins.forEach((bin, index) => {
      if (bin.swap <= 0) return
      bin.swap -= dt
      if (bin.swap > 0) return
      // The full pallet leaves and an empty one takes its place.
      for (let i = this.parts.length - 1; i >= 0; i--) {
        if (this.parts[i].state === 'placed' && this.parts[i].bin === index) {
          this.parts.splice(i, 1)
          this.shipped++
        }
      }
      bin.count = 0
      this.pallets++
    })
  }

  /** The part waiting at the gate, if it has stopped there. */
  private partAtGate(): Part | null {
    const front = this.beltParts[0]
    return front && front.s >= BELT_LENGTH - 1e-6 ? front : null
  }

  private beginJoint(phase: Phase, target: Point): void {
    const to = solveIK(...target)!
    // Turn the base the short way round rather than unwinding through a full turn.
    const from: Joints = [...this.joints]
    while (to[0] - from[0] > Math.PI) to[0] -= Math.PI * 2
    while (to[0] - from[0] < -Math.PI) to[0] += Math.PI * 2
    this.phase = phase
    this.segment = { kind: 'joint', from, to, time: jointMoveTime(from, to) }
    this.elapsed = 0
  }

  private beginLine(phase: Phase, target: Point): void {
    const from = this.tip
    const distance = Math.hypot(target[0] - from[0], target[1] - from[1], target[2] - from[2])
    this.phase = phase
    this.segment = { kind: 'line', from, to: target, time: Math.max(0.12, moveTime(distance, LINEAR_SPEED, LINEAR_ACCEL)) }
    this.elapsed = 0
  }

  private beginHold(phase: Phase, time: number): void {
    this.phase = phase
    this.segment = { kind: 'hold', time }
    this.elapsed = 0
  }

  private stepProgram(dt: number): void {
    this.grip += Math.sign(this.gripTarget - this.grip) * Math.min(Math.abs(this.gripTarget - this.grip), dt / GRIP_TIME)

    const segment = this.segment
    if (!segment) {
      // Waiting above the pick point for a part whose pallet is ready.
      const part = this.partAtGate()
      if (this.phase === 'awaitPart' && part && this.bins[part.color].swap <= 0) {
        this.cycleStart = this.time
        this.beginLine('descendPick', PICK)
      }
      return
    }

    this.elapsed += dt * this.params.speed
    const t = Math.min(1, this.elapsed / segment.time)
    if (segment.kind === 'joint') {
      const s = ease(t)
      for (let j = 0; j < 4; j++) this.joints[j] = segment.from[j] + (segment.to[j] - segment.from[j]) * s
    } else if (segment.kind === 'line') {
      // A straight line for the gripper tip: interpolate in space and solve the joints at every step.
      const s = ease(t)
      const solved = solveIK(
        segment.from[0] + (segment.to[0] - segment.from[0]) * s,
        segment.from[1] + (segment.to[1] - segment.from[1]) * s,
        segment.from[2] + (segment.to[2] - segment.from[2]) * s,
      )
      if (solved) this.follow(solved)
    }
    if (t < 1) return
    this.segment = null
    this.advance()
  }

  /** Takes joint angles from the solver, keeping the base angle continuous. */
  private follow(solved: Joints): void {
    let yaw = solved[0]
    while (yaw - this.joints[0] > Math.PI) yaw -= Math.PI * 2
    while (yaw - this.joints[0] < -Math.PI) yaw += Math.PI * 2
    this.joints[0] = yaw
    this.joints[1] = solved[1]
    this.joints[2] = solved[2]
    this.joints[3] = solved[3]
  }

  /** What the automatic cycle does when a move finishes. */
  private advance(): void {
    switch (this.phase) {
      case 'toPick':
        this.phase = 'awaitPart'
        break
      case 'descendPick': {
        this.gripTarget = 0
        const part = this.partAtGate()
        if (part) {
          part.state = 'held'
          this.held = part
        }
        this.onGrip?.(true)
        this.beginHold('grip', GRIP_TIME)
        break
      }
      case 'grip':
        this.beginLine('liftPick', PICK_HOVER)
        break
      case 'liftPick': {
        if (!this.held) {
          this.phase = 'awaitPart'
          break
        }
        const [x, y, z] = this.slotPosition(this.held.color, this.bins[this.held.color].count)
        this.beginJoint('toPlace', [x, y + HOVER, z])
        break
      }
      case 'toPlace': {
        const part = this.held!
        this.beginLine('descendPlace', this.slotPosition(part.color, this.bins[part.color].count))
        break
      }
      case 'descendPlace':
        this.gripTarget = 1
        this.place(this.held!, this.held!.color)
        this.onGrip?.(false)
        this.beginHold('release', GRIP_TIME)
        break
      case 'release': {
        const [x, y, z] = this.tip
        this.beginLine('liftPlace', [x, y + HOVER, z])
        break
      }
      case 'liftPlace':
        this.lastCycle = this.time - this.cycleStart
        this.beginJoint('toPick', PICK_HOVER)
        break
    }
  }

  /** Sets a part down in the next free slot of a pallet. */
  private place(part: Part, bin: number): void {
    const target = this.bins[bin]
    const [x, y, z] = this.slotPosition(bin, target.count)
    part.x = x
    part.y = y - PART_HEIGHT / 2
    part.z = z
    part.state = 'placed'
    part.bin = bin
    if (part.color !== bin) this.missorted++
    this.held = null
    target.count++
    this.placed++
    this.placements.push(this.time)
    if (target.count >= BIN_CAPACITY) {
      target.swap = SWAP_TIME
      this.onPallet?.(bin)
    }
  }

  /** Manual mode: every joint turns toward the target's solution as fast as its limit allows. */
  private stepManual(dt: number): void {
    this.grip += Math.sign(this.gripTarget - this.grip) * Math.min(Math.abs(this.gripTarget - this.grip), dt / GRIP_TIME)
    const [x, y, z] = this.params.target
    let solved = solveIK(x, y, z)
    this.reachable = solved !== null
    if (!solved) {
      // Out of reach: aim along the same direction from the shoulder, at full stretch.
      const reach = Math.max(Math.hypot(x, z), 0.45)
      const rise = y + ARM.tool - ARM.shoulderHeight
      const distance = Math.hypot(reach, rise)
      const limit = Math.min(ARM.upper + ARM.fore - 0.02, Math.max(distance, Math.abs(ARM.upper - ARM.fore) + 0.02))
      const k = limit / distance
      const yaw = Math.atan2(z, x)
      solved = solveIK(Math.cos(yaw) * reach * k, rise * k - ARM.tool + ARM.shoulderHeight, Math.sin(yaw) * reach * k)
      if (!solved) return
    }
    while (solved[0] - this.joints[0] > Math.PI) solved[0] -= Math.PI * 2
    while (solved[0] - this.joints[0] < -Math.PI) solved[0] += Math.PI * 2
    for (let j = 0; j < 4; j++) {
      const step = JOINT_SPEED[j] * this.params.speed * dt
      this.joints[j] += Math.max(-step, Math.min(step, solved[j] - this.joints[j]))
    }
  }

  /** Closing the gripper by hand picks up a part if its top is right under the tip. */
  private closeOnNearestPart(): void {
    if (this.held) return
    const [x, y, z] = this.tip
    for (const part of this.parts) {
      if (part.state === 'held') continue
      // A stacked part can only be lifted if nothing sits on top of it.
      if (part.state === 'placed' && this.bins[part.bin].count - 1 !== this.slotOf(part)) continue
      if (part.state === 'belt' && part !== this.partAtGate()) continue
      const top = part.y + PART_HEIGHT / 2
      if (Math.hypot(part.x - x, part.z - z) > 0.3 || Math.abs(top - y) > 0.25) continue
      if (part.state === 'placed') {
        this.bins[part.bin].count--
        this.placed--
      }
      part.state = 'held'
      part.bin = -1
      this.held = part
      return
    }
  }

  private slotOf(part: Part): number {
    for (let slot = 0; slot < BIN_CAPACITY; slot++) {
      const [x, , z] = this.slotPosition(part.bin, slot)
      if (Math.hypot(part.x - x, part.z - z) < 0.05 && Math.abs(this.slotPosition(part.bin, slot)[1] - PART_HEIGHT / 2 - part.y) < 0.05) return slot
    }
    return -1
  }

  /** Opening the gripper sets the part on the pallet below it, or drops it to the floor. */
  private releaseHeld(): void {
    const part = this.held
    if (!part) return
    const bin = this.bins.findIndex((candidate) => Math.abs(part.x - candidate.x) < 1.05 && Math.abs(part.z - candidate.z) < 0.75)
    if (bin >= 0 && this.bins[bin].swap <= 0 && this.bins[bin].count < BIN_CAPACITY) {
      this.place(part, bin)
      return
    }
    part.state = 'loose'
    part.y = PART_HEIGHT / 2
    this.held = null
  }
}
