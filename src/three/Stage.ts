import * as THREE from 'three'
import { STEP, type Simulation } from '../simulations/core/Simulation'

/** A rectangle of the page that one simulation is drawn into. */
export interface Slot {
  element: HTMLElement
  simulation: Simulation
  paused: boolean
  /** Set by the owner from an IntersectionObserver; off-screen slots neither step nor render. */
  visible: boolean
  timeScale: number
  /** Simulated seconds elapsed. */
  simTime: number
  /** Called once per frame before rendering (camera controls live here). */
  onFrame: ((delta: number) => void) | null
  accumulator: number
  width: number
  height: number
}

export interface StageInfo {
  fps: number
  frameMs: number
  drawCalls: number
  triangles: number
  geometries: number
  textures: number
  programs: number
  slots: number
  /** Current render scale; drops below the device ratio under load. */
  pixelRatio: number
}

const MAX_DELTA = 0.1
const MIN_PIXEL_RATIO = 0.6
const MAX_STEPS_PER_FRAME = 4

/**
 * The single renderer and animation loop for the whole application.
 *
 * One canvas covers the viewport. Each frame, every visible slot's bounding
 * rect becomes a viewport/scissor region and its simulation is drawn there.
 * The homepage grid and the full-screen viewer are both just slots, so the
 * app never holds more than one WebGL context.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer
  readonly canvas: HTMLCanvasElement
  readonly info: StageInfo = {
    fps: 0,
    frameMs: 0,
    drawCalls: 0,
    triangles: 0,
    geometries: 0,
    textures: 0,
    programs: 0,
    slots: 0,
    pixelRatio: 1,
  }
  contextLost = false

  private slots = new Set<Slot>()
  private lastTime = 0
  private frameHandle = 0
  private canvasWidth = 0
  private canvasHeight = 0
  private fpsFrames = 0
  private maxPixelRatio = 1
  private pixelRatio = 1
  /** Consecutive half-second windows that ran slow / ran with headroom. */
  private slowWindows = 0
  private fastWindows = 0
  private fpsTime = 0

  constructor() {
    const lowSpec = isLowSpec()
    // Multisampling costs the most on the devices that can least afford it.
    this.renderer = new THREE.WebGLRenderer({ antialias: !lowSpec, alpha: true, powerPreference: 'high-performance' })
    this.maxPixelRatio = Math.min(window.devicePixelRatio, lowSpec ? 1.5 : 2)
    this.pixelRatio = this.maxPixelRatio
    this.renderer.setPixelRatio(this.pixelRatio)
    this.info.pixelRatio = this.pixelRatio
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.15
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.setClearColor(0x000000, 0)
    // Info accumulates across all slots in a frame; reset manually each frame.
    this.renderer.info.autoReset = false

    this.canvas = this.renderer.domElement
    this.canvas.className = 'stage-canvas'
    this.canvas.setAttribute('aria-hidden', 'true')
    document.body.prepend(this.canvas)

    this.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault()
      this.contextLost = true
    })
    this.canvas.addEventListener('webglcontextrestored', () => {
      // Three.js re-uploads GPU resources on the next render.
      this.contextLost = false
    })

    document.addEventListener('visibilitychange', this.onVisibilityChange)
    this.start()
  }

  addSlot(element: HTMLElement, simulation: Simulation): Slot {
    const slot: Slot = {
      element,
      simulation,
      paused: false,
      visible: true,
      timeScale: 1,
      simTime: 0,
      onFrame: null,
      accumulator: 0,
      width: 0,
      height: 0,
    }
    this.slots.add(slot)
    return slot
  }

  removeSlot(slot: Slot): void {
    this.slots.delete(slot)
  }

  // Browsers stop delivering animation frames to hidden pages, which pauses
  // every simulation. On return, restart the clock so no catch-up burst runs.
  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') this.lastTime = performance.now()
  }

  private start(): void {
    if (this.frameHandle) return
    this.lastTime = performance.now()
    this.frameHandle = requestAnimationFrame(this.frame)
  }

  private frame = (now: number): void => {
    this.frameHandle = requestAnimationFrame(this.frame)
    const rawDelta = (now - this.lastTime) / 1000
    this.lastTime = now
    const delta = Math.min(rawDelta, MAX_DELTA)

    this.fpsFrames++
    this.fpsTime += rawDelta
    if (this.fpsTime >= 0.5) {
      this.info.fps = Math.round(this.fpsFrames / this.fpsTime)
      this.info.frameMs = (this.fpsTime / this.fpsFrames) * 1000
      this.adaptResolution(this.info.fps)
      this.fpsFrames = 0
      this.fpsTime = 0
    }

    this.draw(delta)
  }

  /**
   * Runs the loop for a span of simulated time without waiting for real
   * frames. For benchmarking and debugging; not used by the application.
   */
  advance(seconds: number): void {
    for (let i = 0; i < Math.round(seconds / STEP); i++) this.draw(STEP)
  }

  /**
   * Dynamic resolution. When the frame rate sags, render fewer pixels; when
   * there is headroom again, climb back toward the device's native ratio.
   * A slow phone settles at a resolution it can hold, and a fast desktop
   * never leaves full resolution.
   */
  private adaptResolution(fps: number): void {
    // A hidden or throttled tab reports a tiny frame rate; that is not load.
    if (fps < 8 || document.visibilityState !== 'visible') {
      this.slowWindows = 0
      this.fastWindows = 0
      return
    }
    this.slowWindows = fps < 48 ? this.slowWindows + 1 : 0
    this.fastWindows = fps >= 57 ? this.fastWindows + 1 : 0
    let next = this.pixelRatio
    if (this.slowWindows >= 2 && this.pixelRatio > MIN_PIXEL_RATIO) {
      next = Math.max(MIN_PIXEL_RATIO, this.pixelRatio * 0.82)
      this.slowWindows = 0
    } else if (this.fastWindows >= 8 && this.pixelRatio < this.maxPixelRatio) {
      // Climb slowly so the resolution does not oscillate around the limit.
      next = Math.min(this.maxPixelRatio, this.pixelRatio * 1.1)
      this.fastWindows = 0
    }
    if (next === this.pixelRatio) return
    this.pixelRatio = next
    this.info.pixelRatio = next
    this.renderer.setPixelRatio(next)
    this.renderer.setSize(this.canvasWidth, this.canvasHeight, true)
  }

  private draw(delta: number): void {
    if (this.contextLost) return

    this.syncCanvas()
    const renderer = this.renderer
    renderer.info.reset()
    renderer.setScissorTest(false)
    renderer.clear()
    renderer.setScissorTest(true)

    for (const slot of this.slots) {
      if (!slot.visible) continue
      const rect = slot.element.getBoundingClientRect()
      const width = Math.round(rect.width)
      const height = Math.round(rect.height)
      if (width < 2 || height < 2) continue
      if (rect.bottom < 0 || rect.top > this.canvasHeight || rect.right < 0 || rect.left > this.canvasWidth) continue

      const simulation = slot.simulation
      if (width !== slot.width || height !== slot.height) {
        slot.width = width
        slot.height = height
        simulation.resize(width, height)
      }

      if (!slot.paused) {
        slot.accumulator = Math.min(slot.accumulator + delta * slot.timeScale, STEP * MAX_STEPS_PER_FRAME)
        while (slot.accumulator >= STEP) {
          simulation.step(STEP)
          slot.simTime += STEP
          slot.accumulator -= STEP
        }
      }

      slot.onFrame?.(delta)
      simulation.render(slot.paused ? 0 : slot.accumulator / STEP)

      const left = Math.round(rect.left)
      const bottom = this.canvasHeight - Math.round(rect.top) - height
      renderer.setViewport(left, bottom, width, height)
      renderer.setScissor(left, bottom, width, height)
      renderer.render(simulation.scene, simulation.camera)
    }

    this.info.drawCalls = renderer.info.render.calls
    this.info.triangles = renderer.info.render.triangles
    this.info.geometries = renderer.info.memory.geometries
    this.info.textures = renderer.info.memory.textures
    this.info.programs = renderer.info.programs?.length ?? 0
    this.info.slots = this.slots.size
  }

  /** Keeps the canvas pinned to the viewport and sized to it. */
  private syncCanvas(): void {
    const width = document.documentElement.clientWidth
    const height = window.innerHeight
    if (width !== this.canvasWidth || height !== this.canvasHeight) {
      this.canvasWidth = width
      this.canvasHeight = height
      this.renderer.setSize(width, height, true)
    }
    // The canvas scrolls with the page between frames and is re-pinned here,
    // which keeps slots glued to their cards while scrolling.
    this.canvas.style.transform = `translate(${window.scrollX}px, ${window.scrollY}px)`
  }
}

export function isMobile(): boolean {
  return window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 640
}

/**
 * Phones, tablets and modest laptops: few cores, little memory, or a touch
 * screen. These get no shadows, no multisampling, a lower resolution ceiling
 * and reduced simulation detail.
 */
export function isLowSpec(): boolean {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  return isMobile() || navigator.hardwareConcurrency <= 4 || (memory !== undefined && memory <= 4)
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

let stage: Stage | null = null

/** Lazily creates the shared stage. Throws if WebGL is unavailable. */
export function getStage(): Stage {
  if (!stage) {
    stage = new Stage()
    if (import.meta.env.DEV) (window as unknown as { __stage: Stage }).__stage = stage
  }
  return stage
}
