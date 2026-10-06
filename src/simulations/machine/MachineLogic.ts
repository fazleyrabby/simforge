import { Box, Circle, MouseJoint, PrismaticJoint, PulleyJoint, RevoluteJoint, World, type Body, type Contact, type Joint } from 'planck'
import type { Rng } from '../core/random'

export type PieceRole =
  | 'frame'
  | 'ramp'
  | 'marble'
  | 'domino'
  | 'ball'
  | 'bucket'
  | 'gate'
  | 'wheel'
  | 'hammer'
  | 'bell'
  | 'striker'
  | 'flap'
  | 'peg'
  | 'stop'

/** One drawable shape. A body with several fixtures contributes several pieces. */
export interface Piece {
  body: Body
  role: PieceRole
  shape: 'box' | 'circle'
  /** Half extents for a box; radius in `halfWidth` for a circle. */
  halfWidth: number
  halfHeight: number
  /** Offset and rotation of the shape within its body. */
  x: number
  y: number
  angle: number
  /** Index used to vary colour within a role. */
  variant: number
}

export interface MachineParams {
  /** Multiplier on the first marble's mass. */
  marbleMass: number
  /** Slope of the launch ramp in degrees. */
  rampAngle: number
  /** Gap between dominoes, in metres. */
  spacing: number
  /** Multiplier on the gate's weight, which the loaded bucket must outweigh. */
  ballast: number
  gravity: number
}

export type MachineStatus = 'ready' | 'running' | 'complete' | 'stalled'

export const STAGES = [
  'Marble released',
  'Dominoes toppling',
  'Last domino over the edge',
  'Bucket loaded',
  'Gate lifted',
  'Paddle wheel turned',
  'Hammer struck',
  'Ball knocked off its tee',
  'Second row toppling',
  'Second bucket loaded',
  'Striker hoisted',
  'Bell rung',
]

/** Seconds without progress before a run counts as stalled. */
const STALL_TIME = 7
const SHELF_Y = 9
const DOMINO_HALF_HEIGHT = 0.5
const BUCKET_X = 4.55
const BUCKET_Y = 7.15
const BUCKET_TRAVEL = 2.5
const GATE_X = 7.9
const PULLEY_Y = 11.5
const HAMMER_PIVOT: [number, number] = [-1.25, 6.6]
const HAMMER_LENGTH = 2.6
const FLOOR_Y = -0.6
const SHELF2_Y = 3
const BUCKET2_X = -9.65
const BUCKET2_Y = 1.15
const BUCKET2_TRAVEL = 1.5
const STRIKER_X = -6.5
const STRIKER_Y = 4.95
const PULLEY2_Y = 8.6
/** Rope let out at the second bucket per unit taken up at the striker. */
const HOIST_RATIO = 0.6
const BELL: [number, number] = [STRIKER_X, 7.7]

/** A rope over two pulleys, with the points where it meets the bodies at each end. */
export interface Rope {
  pulleys: [number, number][]
  a: [number, number]
  b: [number, number]
}

/**
 * A chain-reaction machine, independent of rendering. Rigid-body physics is
 * Planck.js (a port of Box2D); this class builds the contraption, watches for
 * each link in the chain to fire, and reports where a run stalls.
 *
 * The chain: a marble rolls down a ramp into a row of growing dominoes; the
 * last and heaviest topples off the shelf into a bucket; the bucket's weight
 * hauls a gate up by a pulley; a ball rolls out under the gate, through a
 * paddle wheel and a hanging flap, and strikes a hammer. The hammer knocks a second ball off its
 * tee and down into a second row of dominoes; the last of those drops into a
 * second bucket, whose rope hoists a striker up into a bell.
 */
export class MachineLogic {
  readonly world: World
  readonly pieces: Piece[] = []
  /** Number of links in the chain that have fired so far. */
  stage = 0
  status: MachineStatus = 'ready'
  time = 0
  /** Seconds since the marble was released. */
  runTime = 0
  /** When each stage fired, in run time. */
  readonly stageTimes: number[] = []
  onStage: ((stage: number) => void) | null = null
  onEnd: ((status: MachineStatus) => void) | null = null
  /** Hardest contact this step, for sound. */
  impact = 0

  readonly bucket: Body
  readonly gate: Body
  readonly wheel: Body
  readonly hammer: Body
  readonly flap: Body
  /** Fixed axles that pieces turn on: the wheel, the flap and the hammer. */
  readonly pivots: [number, number][]
  readonly bucket2: Body
  readonly striker: Body
  /** Whether the gate holding the first marble is still in place. */
  latched = true
  /** World position of the latch, for drawing. */
  readonly latch: { x: number; y: number; angle: number }

  private ground: Body
  private latchBody: Body
  private dominoes: Body[] = []
  private payload: Body
  private ballC: Body
  private marble: Body
  private gateRest: number
  private lastProgress = 0
  private mouse: Joint | null = null
  private bobHit = false
  private bellHit = false
  private bucketLoaded = false
  private bucket2Loaded = false
  private dominoes2: Body[] = []
  private ballD: Body

  constructor(
    rng: Rng,
    readonly params: MachineParams,
  ) {
    this.world = new World({ gravity: { x: 0, y: -params.gravity } })
    this.ground = this.world.createBody()
    const world = this.world

    // --- Frame: floor and side walls keep everything on the board.
    this.fixed('frame', 0, FLOOR_Y, 11.4, 0.12)
    this.fixed('frame', -11.3, 5.75, 0.12, 6.35)
    this.fixed('frame', 11.05, 5.75, 0.12, 6.35)

    // --- Launch ramp, pivoting about its lower end where it meets the shelf.
    const slope = (params.rampAngle * Math.PI) / 180
    const rampLength = 5.3
    const rampFoot: [number, number] = [-4.85, SHELF_Y + 0.02]
    const rampTop: [number, number] = [rampFoot[0] - rampLength * Math.cos(slope), rampFoot[1] + rampLength * Math.sin(slope)]
    this.plank('ramp', rampTop[0], rampTop[1], rampFoot[0], rampFoot[1])
    // Backstop behind the marble.
    this.fixed('stop', rampTop[0] - 0.1, rampTop[1] + 0.35, 0.08, 0.45, -slope)
    const along = (distance: number, lift: number): [number, number] => [
      rampTop[0] + distance * Math.cos(slope) + lift * Math.sin(slope),
      rampTop[1] - distance * Math.sin(slope) + lift * Math.cos(slope),
    ]
    const marbleRadius = 0.3
    const [marbleX, marbleY] = along(0.42, marbleRadius + 0.01)
    this.marble = this.ball('marble', marbleX, marbleY, marbleRadius, 4 * params.marbleMass, 0)
    const [latchX, latchY] = along(0.42 + marbleRadius + 0.09, 0.28)
    this.latch = { x: latchX, y: latchY, angle: -slope }
    this.latchBody = world.createBody({ position: { x: latchX, y: latchY }, angle: -slope })
    this.latchBody.createFixture({ shape: new Box(0.06, 0.3), friction: 0.2 })

    // --- Domino shelf. Each domino is a little bigger than the one before, so the
    // push grows down the row (a domino can topple one about half again its size).
    // The row is packed against the shelf's far edge: the last and heaviest
    // domino goes over that edge and becomes the weight that loads the bucket.
    const edge = 3.5
    this.dominoes = this.dominoRow(rng.int(6, 8), edge, SHELF_Y, 1, 7.2, 'payload', 0)
    this.payload = this.dominoes[this.dominoes.length - 1]
    this.plank('ramp', -4.9, SHELF_Y, edge, SHELF_Y)

    // --- Bucket on a vertical guide, roped over two pulleys to the gate.
    this.bucket = world.createBody({ type: 'dynamic', position: { x: BUCKET_X, y: BUCKET_Y } })
    const bucketParts: [number, number, number, number][] = [
      [0, 0.05, 0.72, 0.05],
      [-0.68, 0.5, 0.05, 0.5],
      [0.68, 0.5, 0.05, 0.5],
    ]
    bucketParts.forEach(([x, y, halfWidth, halfHeight], i) => {
      const fixture = this.bucket.createFixture({ shape: new Box(halfWidth, halfHeight, { x, y }), density: 0.9, friction: 0.6 })
      fixture.setUserData('bucket')
      this.pieces.push({ body: this.bucket, role: 'bucket', shape: 'box', halfWidth, halfHeight, x, y, angle: 0, variant: i })
    })
    world.createJoint(
      new PrismaticJoint({ enableLimit: true, lowerTranslation: -BUCKET_TRAVEL, upperTranslation: 0 }, this.ground, this.bucket, { x: BUCKET_X, y: BUCKET_Y }, { x: 0, y: 1 }),
    )
    // A deflector stops the ball overshooting the bucket.
    this.fixed('stop', 5.42, 8.9, 0.07, 0.75)

    // --- Third ball on a ramp, held back by the gate.
    const ramp3: [number, number, number, number] = [6.15, 8.25, 9.95, 7.4]
    this.plank('ramp', ...ramp3)
    this.fixed('stop', 6.1, 8.75, 0.07, 0.45)
    const surface = (x: number) => ramp3[1] + ((x - ramp3[0]) * (ramp3[3] - ramp3[1])) / (ramp3[2] - ramp3[0])
    const gateHalf = 0.7
    this.gateRest = surface(GATE_X) + 0.05 + gateHalf
    this.gate = world.createBody({ type: 'dynamic', position: { x: GATE_X, y: this.gateRest } })
    this.gate.createFixture({ shape: new Box(0.11, gateHalf), density: (0.44 * params.ballast) / (0.22 * gateHalf * 2), friction: 0.1 })
    this.pieces.push({ body: this.gate, role: 'gate', shape: 'box', halfWidth: 0.11, halfHeight: gateHalf, x: 0, y: 0, angle: 0, variant: 0 })
    world.createJoint(
      new PrismaticJoint({ enableLimit: true, lowerTranslation: 0, upperTranslation: BUCKET_TRAVEL }, this.ground, this.gate, { x: GATE_X, y: this.gateRest }, { x: 0, y: 1 }),
    )
    world.createJoint(
      new PulleyJoint(
        {},
        this.bucket,
        this.gate,
        { x: BUCKET_X, y: PULLEY_Y },
        { x: GATE_X, y: PULLEY_Y },
        { x: BUCKET_X, y: BUCKET_Y + 1 },
        { x: GATE_X, y: this.gateRest + gateHalf },
        1,
      ),
    )
    const ballCX = GATE_X - 0.11 - 0.3 - 0.02
    this.ballC = this.ball('ball', ballCX, surface(ballCX) + 0.33, 0.3, 3, 0)

    // --- Long ramp back across the board, through a paddle wheel.
    const ramp4: [number, number, number, number] = [10.9, 5.3, 2.5, 3.6]
    this.plank('ramp', ...ramp4)
    this.plank('ramp', 2.5, 3.6, -0.75, 3.6)
    const wheelX = 6.4
    const wheelY = ramp4[3] + ((wheelX - ramp4[2]) * (ramp4[1] - ramp4[3])) / (ramp4[0] - ramp4[2]) + 1.22
    this.wheel = world.createBody({ type: 'dynamic', position: { x: wheelX, y: wheelY }, angularDamping: 0.25 })
    for (let i = 0; i < 2; i++) {
      this.wheel.createFixture({ shape: new Box(1, 0.045, { x: 0, y: 0 }, (i * Math.PI) / 2), density: 0.25, friction: 0.1 })
      this.pieces.push({ body: this.wheel, role: 'wheel', shape: 'box', halfWidth: 1, halfHeight: 0.045, x: 0, y: 0, angle: (i * Math.PI) / 2, variant: i })
    }
    this.wheel.setAngle(Math.PI / 4)
    world.createJoint(new RevoluteJoint({}, this.ground, this.wheel, { x: wheelX, y: wheelY }))

    // --- Hammer hanging at the end of the run, and the bell it swings into.
    this.hammer = world.createBody({ type: 'dynamic', position: { x: HAMMER_PIVOT[0], y: HAMMER_PIVOT[1] }, angularDamping: 0.05 })
    this.hammer.createFixture({ shape: new Box(0.045, HAMMER_LENGTH / 2, { x: 0, y: -HAMMER_LENGTH / 2 }), density: 0.2, friction: 0.2 })
    this.pieces.push({ body: this.hammer, role: 'hammer', shape: 'box', halfWidth: 0.045, halfHeight: HAMMER_LENGTH / 2, x: 0, y: -HAMMER_LENGTH / 2, angle: 0, variant: 0 })
    const bob = this.hammer.createFixture({ shape: new Circle({ x: 0, y: -HAMMER_LENGTH }, 0.36), density: 2.1, friction: 0.2, restitution: 0.55 })
    bob.setUserData('bob')
    this.pieces.push({ body: this.hammer, role: 'hammer', shape: 'circle', halfWidth: 0.36, halfHeight: 0.36, x: 0, y: -HAMMER_LENGTH, angle: 0, variant: 1 })
    world.createJoint(new RevoluteJoint({}, this.ground, this.hammer, { x: HAMMER_PIVOT[0], y: HAMMER_PIVOT[1] }))

    // --- A flap hanging over the ramp, which the ball has to push through.
    const flapX = 3.9
    const flapY = ramp4[3] + ((flapX - ramp4[2]) * (ramp4[1] - ramp4[3])) / (ramp4[0] - ramp4[2]) + 1.5
    this.flap = world.createBody({ type: 'dynamic', position: { x: flapX, y: flapY }, angularDamping: 0.4 })
    this.flap.createFixture({ shape: new Box(0.05, 0.68, { x: 0, y: -0.68 }), density: 0.5, friction: 0.1 })
    this.pieces.push({ body: this.flap, role: 'flap', shape: 'box', halfWidth: 0.05, halfHeight: 0.68, x: 0, y: -0.68, angle: 0, variant: 0 })
    world.createJoint(new RevoluteJoint({}, this.ground, this.flap, { x: flapX, y: flapY }))
    this.pivots = [
      [wheelX, wheelY],
      [flapX, flapY],
      HAMMER_PIVOT,
    ]

    // --- Below the hammer the spent ball drops through a field of pegs and rolls away
    // down a sloping floor, clear of the second bucket.
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < (row % 2 === 0 ? 4 : 3); column++) {
        const x = -2.45 + column * 0.98 + (row % 2) * 0.49
        const y = 2.75 - row * 0.72
        this.ground.createFixture({ shape: new Circle({ x, y }, 0.09), friction: 0.2, restitution: 0.35 })
        this.pieces.push({ body: this.ground, role: 'peg', shape: 'circle', halfWidth: 0.09, halfHeight: 0.09, x, y, angle: 0, variant: row })
      }
    }
    this.fixed('stop', -3.3, 0.7, 0.07, 0.75)
    this.plank('ramp', -3.3, 0.35, 10.93, -0.4)

    // --- A ball on a tee beside the hammer, and the ramp it takes down to the second shelf.
    this.plank('ramp', -1.7, 3.6, -2.4, 3.6)
    this.plank('ramp', -2.4, 3.6, -4.4, SHELF2_Y + 0.02)
    this.ballD = this.ball('ball', HAMMER_PIVOT[0] - 0.36 - 0.3 - 0.04, 3.6 + 0.3, 0.3, 2, 1)

    // --- Second domino row, falling the other way, off the shelf's left edge.
    const edge2 = -8.6
    this.plank('ramp', -4.4, SHELF2_Y, edge2, SHELF2_Y)
    this.dominoes2 = this.dominoRow(rng.int(5, 6), edge2, SHELF2_Y, -1, 3.3, 'payload2', 10)

    // --- Second bucket. Its rope is geared: the bucket's short drop hoists the striker further.
    this.bucket2 = world.createBody({ type: 'dynamic', position: { x: BUCKET2_X, y: BUCKET2_Y } })
    bucketParts.forEach(([x, y, halfWidth, halfHeight], i) => {
      const fixture = this.bucket2.createFixture({ shape: new Box(halfWidth, halfHeight, { x, y }), density: 0.9, friction: 0.6 })
      fixture.setUserData('bucket2')
      this.pieces.push({ body: this.bucket2, role: 'bucket', shape: 'box', halfWidth, halfHeight, x, y, angle: 0, variant: i })
    })
    world.createJoint(
      new PrismaticJoint({ enableLimit: true, lowerTranslation: -BUCKET2_TRAVEL, upperTranslation: 0 }, this.ground, this.bucket2, { x: BUCKET2_X, y: BUCKET2_Y }, { x: 0, y: 1 }),
    )
    this.fixed('stop', edge2 - 1.92, SHELF2_Y - 0.1, 0.07, 0.75)

    this.striker = world.createBody({ type: 'dynamic', position: { x: STRIKER_X, y: STRIKER_Y } })
    const striker = this.striker.createFixture({ shape: new Circle(0.22), density: 0.24 / (Math.PI * 0.22 * 0.22), restitution: 0.4 })
    striker.setUserData('striker')
    this.pieces.push({ body: this.striker, role: 'striker', shape: 'circle', halfWidth: 0.22, halfHeight: 0.22, x: 0, y: 0, angle: 0, variant: 0 })
    world.createJoint(
      new PrismaticJoint({ enableLimit: true, lowerTranslation: 0, upperTranslation: 3 }, this.ground, this.striker, { x: STRIKER_X, y: STRIKER_Y }, { x: 0, y: 1 }),
    )
    world.createJoint(
      new PulleyJoint(
        {},
        this.bucket2,
        this.striker,
        { x: BUCKET2_X, y: PULLEY2_Y },
        { x: STRIKER_X, y: PULLEY2_Y },
        { x: BUCKET2_X, y: BUCKET2_Y + 1 },
        { x: STRIKER_X, y: STRIKER_Y + 0.22 },
        HOIST_RATIO,
      ),
    )

    // The bell is its own body: bodies joined by a joint (the striker and the board) do not collide.
    const bellBody = world.createBody({ position: { x: BELL[0], y: BELL[1] } })
    const bell = bellBody.createFixture({ shape: new Circle(0.5), restitution: 0.6 })
    bell.setUserData('bell')
    this.pieces.push({ body: bellBody, role: 'bell', shape: 'circle', halfWidth: 0.5, halfHeight: 0.5, x: 0, y: 0, angle: 0, variant: 0 })

    this.ballC.getFixtureList()!.setUserData('ball-c')
    world.on('begin-contact', this.onContact)
    world.on('post-solve', (_contact, impulse) => {
      this.impact = Math.max(this.impact, impulse.normalImpulses[0] ?? 0)
    })
  }

  /** Pull the latch: the marble starts to roll. */
  release(): void {
    if (!this.latched) return
    this.latched = false
    this.world.destroyBody(this.latchBody)
    this.marble.setAwake(true)
    this.status = 'running'
    this.runTime = 0
    this.lastProgress = 0
    this.advance(1)
  }

  step(dt: number): void {
    this.impact = 0
    this.world.step(dt, 8, 3)
    this.time += dt
    if (this.status !== 'running') return
    this.runTime += dt

    if (this.stage === 1 && Math.abs(this.dominoes[0].getAngle()) > 0.3) this.advance(2)
    if (this.stage === 2 && this.payload.getPosition().y < SHELF_Y) this.advance(3)
    if (this.stage === 3 && this.bucketLoaded) this.advance(4)
    if (this.stage === 4 && this.gate.getPosition().y - this.gateRest > 0.75) this.advance(5)
    if (this.stage === 5 && Math.abs(this.wheel.getAngle() - Math.PI / 4) > 1) this.advance(6)
    if (this.stage === 6 && this.bobHit) this.advance(7)
    if (this.stage === 7 && this.ballD.getPosition().x < -2.5) this.advance(8)
    if (this.stage === 8 && Math.abs(this.dominoes2[0].getAngle()) > 0.3) this.advance(9)
    if (this.stage === 9 && this.bucket2Loaded) this.advance(10)
    if (this.stage === 10 && this.striker.getPosition().y - STRIKER_Y > 0.75) this.advance(11)
    if (this.stage === 11 && this.bellHit) {
      this.advance(STAGES.length)
      this.status = 'complete'
      this.onEnd?.('complete')
    } else if (this.runTime - this.lastProgress > STALL_TIME) {
      this.status = 'stalled'
      this.onEnd?.('stalled')
    }
  }

  /** How far the gate has been hauled up, 0..1. */
  get gateLift(): number {
    return Math.max(0, Math.min(1, (this.gate.getPosition().y - this.gateRest) / BUCKET_TRAVEL))
  }

  /** Both ropes: bucket to gate, and second bucket to striker. */
  get ropes(): Rope[] {
    const bucket = this.bucket.getPosition()
    const gate = this.gate.getPosition()
    const bucket2 = this.bucket2.getPosition()
    const striker = this.striker.getPosition()
    return [
      {
        pulleys: [
          [BUCKET_X, PULLEY_Y],
          [GATE_X, PULLEY_Y],
        ],
        a: [bucket.x, bucket.y + 1],
        b: [gate.x, gate.y + 0.7],
      },
      {
        pulleys: [
          [BUCKET2_X, PULLEY2_Y],
          [STRIKER_X, PULLEY2_Y],
        ],
        a: [bucket2.x, bucket2.y + 1],
        b: [striker.x, striker.y + 0.22],
      },
    ]
  }

  /** How far the striker has been hoisted toward the bell, in metres. */
  get strikerLift(): number {
    return this.striker.getPosition().y - STRIKER_Y
  }

  get bellAt(): [number, number] {
    return BELL
  }

  /** Extent of the board: left, right, floor and top. */
  get bounds(): [number, number, number, number] {
    return [-11.3, 11.05, FLOOR_Y, 12.1]
  }

  /** Take hold of whatever movable piece is under a point. Returns false if nothing is there. */
  grab(x: number, y: number): boolean {
    this.drop()
    // Try the point itself, then rings around it, so a near miss or a fingertip still catches a small piece.
    for (const radius of [0, 0.18, 0.36]) {
      const samples = radius === 0 ? 1 : 8
      for (let i = 0; i < samples; i++) {
        const px = x + Math.cos((i * Math.PI) / 4) * radius
        const py = y + Math.sin((i * Math.PI) / 4) * radius
        const body = this.bodyAt(px, py)
        if (!body) continue
        this.mouse = this.world.createJoint(new MouseJoint({ maxForce: 250 * body.getMass() }, this.ground, body, { x: px, y: py }))
        body.setAwake(true)
        return this.mouse !== null
      }
    }
    return false
  }

  private bodyAt(x: number, y: number): Body | null {
    let found: Body | null = null
    this.world.queryAABB({ lowerBound: { x: x - 0.05, y: y - 0.05 }, upperBound: { x: x + 0.05, y: y + 0.05 } }, (fixture) => {
      const body = fixture.getBody()
      if (!body.isDynamic() || !fixture.testPoint({ x, y })) return true
      found = body
      return false
    })
    return found as Body | null
  }

  drag(x: number, y: number): void {
    ;(this.mouse as MouseJoint | null)?.setTarget({ x, y })
  }

  drop(): void {
    if (this.mouse) this.world.destroyJoint(this.mouse)
    this.mouse = null
  }

  private advance(stage: number): void {
    this.stage = stage
    this.stageTimes[stage - 1] = this.runTime
    this.lastProgress = this.runTime
    this.onStage?.(stage)
  }

  private onContact = (contact: Contact): void => {
    const a = contact.getFixtureA().getUserData()
    const b = contact.getFixtureB().getUserData()
    const pair = (first: string, second: string) => (a === first && b === second) || (a === second && b === first)
    if (pair('payload', 'bucket')) this.bucketLoaded = true
    if (pair('ball-c', 'bob')) this.bobHit = true
    if (pair('payload2', 'bucket2')) this.bucket2Loaded = true
    if (pair('striker', 'bell')) this.bellHit = true
  }

  /**
   * A row of dominoes on a shelf, packed against the shelf's edge and toppling
   * toward it (`direction` 1 = rightward). Each domino is a little bigger than
   * the one before, so the push grows down the row; the last and heaviest goes
   * over the edge and becomes the weight that loads a bucket.
   */
  private dominoRow(wanted: number, edge: number, shelf: number, direction: 1 | -1, room: number, tag: string, variantBase: number): Body[] {
    const scaleAt = (i: number, count: number) => 1 + (0.45 * i) / Math.max(count - 1, 1)
    const offsets = (n: number) => {
      const xs = new Array<number>(n)
      xs[n - 1] = 0.2
      for (let i = n - 2; i >= 0; i--) xs[i] = xs[i + 1] + this.params.spacing * scaleAt(i, n)
      return xs
    }
    let count = wanted
    while (count > 2 && offsets(count)[0] > room) count--
    const xs = offsets(count)
    const row: Body[] = []
    for (let i = 0; i < count; i++) {
      const scale = scaleAt(i, count)
      const halfWidth = 0.07 * scale
      const halfHeight = DOMINO_HALF_HEIGHT * scale
      const last = i === count - 1
      const body = this.world.createBody({ type: 'dynamic', position: { x: edge - direction * xs[i], y: shelf + halfHeight } })
      const fixture = body.createFixture({ shape: new Box(halfWidth, halfHeight), density: last ? 2 : 1.2, friction: 0.55, restitution: 0.05 })
      if (last) fixture.setUserData(tag)
      row.push(body)
      this.pieces.push({ body, role: 'domino', shape: 'box', halfWidth, halfHeight, x: 0, y: 0, angle: 0, variant: last ? -1 : variantBase + i })
    }
    return row
  }

  /** A static rectangle fixed to the board. */
  private fixed(role: PieceRole, x: number, y: number, halfWidth: number, halfHeight: number, angle = 0): void {
    this.ground.createFixture({ shape: new Box(halfWidth, halfHeight, { x, y }, angle), friction: 0.5 })
    this.pieces.push({ body: this.ground, role, shape: 'box', halfWidth, halfHeight, x, y, angle, variant: 0 })
  }

  /** A static plank whose top surface runs from one point to another. */
  private plank(role: PieceRole, x1: number, y1: number, x2: number, y2: number): void {
    const thickness = 0.07
    const angle = Math.atan2(y2 - y1, x2 - x1)
    const length = Math.hypot(x2 - x1, y2 - y1)
    // Shift the center below the surface line so the points given are on top.
    const flip = Math.cos(angle) < 0 ? -1 : 1
    const x = (x1 + x2) / 2 + Math.sin(angle) * thickness * flip
    const y = (y1 + y2) / 2 - Math.cos(angle) * thickness * flip
    this.fixed(role, x, y, length / 2, thickness, angle)
  }

  private ball(role: PieceRole, x: number, y: number, radius: number, density: number, variant: number): Body {
    const body = this.world.createBody({ type: 'dynamic', position: { x, y }, angularDamping: 0.05 })
    body.createFixture({ shape: new Circle(radius), density, friction: 0.45, restitution: 0.25 })
    this.pieces.push({ body, role, shape: 'circle', halfWidth: radius, halfHeight: radius, x: 0, y: 0, angle: 0, variant })
    return body
  }
}
