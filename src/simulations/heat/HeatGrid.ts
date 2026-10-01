/**
 * A square grid of temperatures in [0, 1], independent of rendering.
 *
 * Each iteration every cell moves toward the average of its four neighbours
 * (explicit diffusion), loses a fraction to cooling, and source cells are held
 * at their source temperature. Edges are insulated.
 */
export class HeatGrid {
  temperature: Float32Array
  /** Held temperature per cell; 0 means the cell is not a source. */
  source: Float32Array
  private scratch: Float32Array

  constructor(readonly size: number) {
    this.temperature = new Float32Array(size * size)
    this.source = new Float32Array(size * size)
    this.scratch = new Float32Array(size * size)
  }

  /**
   * One diffusion iteration.
   * @param alpha diffusion number, stable for alpha <= 0.25
   * @param cooling fraction of heat lost this iteration
   */
  step(alpha: number, cooling: number): void {
    const n = this.size
    const current = this.temperature
    const next = this.scratch
    const keep = 1 - cooling
    for (let y = 0; y < n; y++) {
      const row = y * n
      const up = (y > 0 ? y - 1 : y) * n
      const down = (y < n - 1 ? y + 1 : y) * n
      for (let x = 0; x < n; x++) {
        const left = x > 0 ? x - 1 : x
        const right = x < n - 1 ? x + 1 : x
        const center = current[row + x]
        const laplacian = current[row + left] + current[row + right] + current[up + x] + current[down + x] - 4 * center
        const held = this.source[row + x]
        next[row + x] = held > 0 ? held : (center + alpha * laplacian) * keep
      }
    }
    this.temperature = next
    this.scratch = current
  }

  /** Applies fn to every cell within radius of (cx, cy), with a 0..1 falloff weight. */
  private brush(cx: number, cy: number, radius: number, fn: (index: number, weight: number) => void): void {
    const n = this.size
    const reach = Math.ceil(radius)
    for (let y = Math.max(0, Math.floor(cy) - reach); y <= Math.min(n - 1, Math.floor(cy) + reach); y++) {
      for (let x = Math.max(0, Math.floor(cx) - reach); x <= Math.min(n - 1, Math.floor(cx) + reach); x++) {
        const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
        if (distance <= radius) fn(y * n + x, 1 - distance / (radius + 1))
      }
    }
  }

  /** Creates a persistent heat source. */
  paint(cx: number, cy: number, radius: number, strength: number): void {
    this.brush(cx, cy, radius, (index) => {
      this.source[index] = Math.max(this.source[index], strength)
      this.temperature[index] = Math.max(this.temperature[index], strength)
    })
  }

  /** Removes sources and the heat under the brush. */
  erase(cx: number, cy: number, radius: number): void {
    this.brush(cx, cy, radius, (index) => {
      this.source[index] = 0
      this.temperature[index] = 0
    })
  }

  /** Adds heat without creating a source (used by wandering emitters). */
  inject(cx: number, cy: number, radius: number, strength: number): void {
    this.brush(cx, cy, radius, (index, weight) => {
      this.temperature[index] = Math.max(this.temperature[index], strength * weight)
    })
  }

  max(): number {
    let max = 0
    for (let i = 0; i < this.temperature.length; i++) if (this.temperature[i] > max) max = this.temperature[i]
    return max
  }

  average(): number {
    let sum = 0
    for (let i = 0; i < this.temperature.length; i++) sum += this.temperature[i]
    return sum / this.temperature.length
  }

  /** Copies this field onto a grid of another resolution (nearest sample). */
  resample(size: number): HeatGrid {
    const grid = new HeatGrid(size)
    const ratio = this.size / size
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const from = Math.min(this.size - 1, Math.floor((y + 0.5) * ratio)) * this.size + Math.min(this.size - 1, Math.floor((x + 0.5) * ratio))
        grid.temperature[y * size + x] = this.temperature[from]
        grid.source[y * size + x] = this.source[from]
      }
    }
    return grid
  }
}
