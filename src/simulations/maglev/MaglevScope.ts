import * as THREE from 'three'
import { palette } from '../../three/palette'

/** The bench controller's live gap, setpoint and coil-current display. */
export class MaglevScope {
  readonly group = new THREE.Group()
  private context: CanvasRenderingContext2D
  private texture: THREE.CanvasTexture
  private gap: number[] = []
  private target: number[] = []
  private current: number[] = []
  private readonly count: number

  constructor(preview: boolean) {
    const canvas = document.createElement('canvas')
    canvas.width = preview ? 384 : 768
    canvas.height = preview ? 224 : 448
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D is required for the magnetic controller')
    this.context = context
    this.texture = new THREE.CanvasTexture(canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.count = preview ? 72 : 144

    const shell = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.72, roughness: 0.39 })
    const trim = new THREE.MeshStandardMaterial({ color: palette.steelLight, metalness: 0.66, roughness: 0.4 })
    const amber = new THREE.MeshStandardMaterial({ color: palette.amber, emissive: palette.amber, emissiveIntensity: 0.45 })
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.65, 1.85, 0.42), shell)
    body.position.y = 1.18
    body.castShadow = true
    this.group.add(body)
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(2.43, 1.5, 0.025), trim)
    bezel.position.set(0, 1.28, 0.235)
    this.group.add(bezel)
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(2.34, 1.4), new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false }))
    screen.position.set(0, 1.28, 0.252)
    this.group.add(screen)
    for (let i = 0; i < 3; i++) {
      const button = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.055, 12), i === 0 ? amber : trim)
      button.rotation.x = Math.PI / 2
      button.position.set(-0.85 + i * 0.25, 0.34, 0.25)
      this.group.add(button)
    }
    const foot = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.16, 1.25), shell)
    foot.position.y = 0.08
    this.group.add(foot)
    this.group.position.set(3.95, 0, -1.75)
    this.draw(0.8, 0, 'AUTO')
  }

  sample(gap: number, target: number, current: number, status: string): void {
    this.gap.push(gap)
    this.target.push(target)
    this.current.push(current)
    if (this.gap.length > this.count) {
      this.gap.shift(); this.target.shift(); this.current.shift()
    }
    this.draw(target, current, status)
  }

  clear(target: number): void {
    this.gap = []
    this.target = []
    this.current = []
    this.draw(target, 0, 'AUTO')
  }

  private draw(target: number, current: number, status: string): void {
    const ctx = this.context
    const w = ctx.canvas.width
    const h = ctx.canvas.height
    ctx.fillStyle = '#07131a'
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = '#24404c'
    ctx.lineWidth = 1
    for (let n = 1; n < 8; n++) {
      ctx.beginPath(); ctx.moveTo(w * n / 8, 0); ctx.lineTo(w * n / 8, h); ctx.stroke()
    }
    for (let n = 1; n < 6; n++) {
      ctx.beginPath(); ctx.moveTo(0, h * n / 6); ctx.lineTo(w, h * n / 6); ctx.stroke()
    }
    ctx.font = `${Math.round(h * 0.061)}px monospace`
    ctx.fillStyle = '#c2d1d9'
    ctx.fillText('LEVITATION / FEEDBACK', w * 0.05, h * 0.115)
    ctx.fillStyle = status === 'STABLE' ? '#5fd38d' : '#ffb020'
    ctx.fillText(status, w * 0.73, h * 0.115)
    ctx.fillStyle = '#ffb020'
    ctx.fillText(`${(target * 100).toFixed(0)} cm SET`, w * 0.05, h * 0.87)
    ctx.fillStyle = '#4cc9f0'
    ctx.fillText(`${current.toFixed(2)} A`, w * 0.73, h * 0.87)
    this.trace(this.target, '#ffb020', h * 0.62, 0.45, 1.6)
    this.trace(this.gap, '#5fd38d', h * 0.62, 0.45, 1.6)
    this.trace(this.current, '#4cc9f0', h * 0.35, 0, 4.5)
    this.texture.needsUpdate = true
  }

  private trace(values: number[], color: string, center: number, min: number, max: number): void {
    if (values.length < 2) return
    const ctx = this.context
    const w = ctx.canvas.width
    const h = ctx.canvas.height
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(2, h * 0.006)
    ctx.beginPath()
    values.forEach((value, i) => {
      const x = i / (this.count - 1) * w
      const y = center + ((value - min) / (max - min) - 0.5) * h * 0.25
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }
}
