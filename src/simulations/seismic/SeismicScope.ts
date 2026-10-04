import * as THREE from 'three'
import { palette } from '../../three/palette'

/** A physical two-channel instrument mounted on the test bench. */
export class SeismicScope {
  readonly group = new THREE.Group()
  private context: CanvasRenderingContext2D
  private texture: THREE.CanvasTexture
  private table: number[] = []
  private roof: number[] = []
  private readonly samples: number

  constructor(preview: boolean) {
    const canvas = document.createElement('canvas')
    canvas.width = preview ? 384 : 768
    canvas.height = preview ? 192 : 384
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D is required for the shake-table scope')
    this.context = context
    this.texture = new THREE.CanvasTexture(canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.samples = preview ? 64 : 128

    const shell = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.68, roughness: 0.38 })
    const trim = new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.7, roughness: 0.34 })
    const frame = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.55, 0.28), shell)
    frame.position.y = 1.65
    frame.castShadow = true
    this.group.add(frame)
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(2.36, 1.22, 0.035), trim)
    bezel.position.set(0, 1.72, 0.158)
    this.group.add(bezel)
    const display = new THREE.Mesh(
      new THREE.PlaneGeometry(2.23, 1.09),
      new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false }),
    )
    display.position.set(0, 1.72, 0.181)
    this.group.add(display)
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.84, 0.28), shell)
    neck.position.y = 0.46
    this.group.add(neck)
    const foot = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 0.9), shell)
    foot.position.y = 0.08
    this.group.add(foot)

    this.group.position.set(3.7, 0, -2.08)
    this.draw(0, 0)
  }

  sample(tableX: number, roofX: number, ratio: number, peakCm: number): void {
    this.table.push(tableX)
    this.roof.push(roofX)
    if (this.table.length > this.samples) this.table.shift()
    if (this.roof.length > this.samples) this.roof.shift()
    this.draw(ratio, peakCm)
  }

  reset(): void {
    this.table = []
    this.roof = []
    this.draw(0, 0)
  }

  private draw(ratio: number, peakCm: number): void {
    const ctx = this.context
    const width = ctx.canvas.width
    const height = ctx.canvas.height
    ctx.fillStyle = '#071019'
    ctx.fillRect(0, 0, width, height)
    ctx.strokeStyle = '#203947'
    ctx.lineWidth = 1
    for (let i = 1; i < 8; i++) {
      const x = width * i / 8
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke()
    }
    for (let i = 1; i < 6; i++) {
      const y = height * i / 6
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke()
    }
    ctx.fillStyle = '#b7cbd5'
    ctx.font = `${Math.round(height * 0.069)}px monospace`
    ctx.fillText('TABLE / ROOF RESPONSE', width * 0.045, height * 0.12)
    ctx.fillStyle = '#ffb020'
    ctx.fillText(`${peakCm.toFixed(0)} cm PK`, width * 0.75, height * 0.12)
    ctx.fillStyle = '#79909c'
    ctx.fillText(`f / fn  ${ratio.toFixed(2)}`, width * 0.045, height * 0.93)
    ctx.fillStyle = '#4cc9f0'
    ctx.fillText('BASE', width * 0.59, height * 0.93)
    ctx.fillStyle = '#ffb020'
    ctx.fillText('ROOF', width * 0.79, height * 0.93)
    this.trace(this.table, 0.11, '#4cc9f0', height * 0.41)
    this.trace(this.roof, 1.5, '#ffb020', height * 0.66)
    this.texture.needsUpdate = true
  }

  private trace(values: number[], range: number, color: string, centerY: number): void {
    const ctx = this.context
    if (values.length < 2) return
    const width = ctx.canvas.width
    const height = ctx.canvas.height
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(2, height * 0.008)
    ctx.beginPath()
    for (let i = 0; i < values.length; i++) {
      const x = i / (this.samples - 1) * width
      const y = centerY - THREE.MathUtils.clamp(values[i] / range, -1, 1) * height * 0.15
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
}
