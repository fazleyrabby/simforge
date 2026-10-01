import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { Rng } from '../core/random'
import type { DebrisSystem, PressFX } from './PressFX'
import type { PressObjectDef } from './PressLogic'

// ---------------------------------------------------------------------------
// 84×48 monochrome LCD with 5×7 bitmap font
// ---------------------------------------------------------------------------

const FONT: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  e: ['00000', '00000', '01110', '10001', '11111', '10000', '01110'],
  n: ['00000', '00000', '10110', '11001', '10001', '10001', '10001'],
  u: ['00000', '00000', '10001', '10001', '10001', '10011', '01101'],
}

export class NokiaLCD {
  readonly w = 84
  readonly h = 48
  readonly px = 4
  readonly buf = new Uint8Array(84 * 48)
  readonly canvas: HTMLCanvasElement
  readonly texture: THREE.CanvasTexture

  constructor() {
    this.canvas = document.createElement('canvas')
    this.canvas.width = this.w * this.px
    this.canvas.height = this.h * this.px
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.anisotropy = 8
  }

  clear(): void {
    this.buf.fill(0)
  }

  set(x: number, y: number): void {
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    if (ix >= 0 && iy >= 0 && ix < this.w && iy < this.h) {
      this.buf[iy * this.w + ix] = 1
    }
  }

  rect(x: number, y: number, w: number, h: number): void {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        this.set(x + i, y + j)
      }
    }
  }

  text(str: string, x: number, y: number): void {
    let curX = x
    for (const ch of str) {
      const g = FONT[ch] || FONT[' ']
      g.forEach((row, j) => {
        for (let i = 0; i < 5; i++) {
          if (row[i] === '1') this.set(curX + i, y + j)
        }
      })
      curX += 6
    }
  }

  textCenter(str: string, y: number): void {
    this.text(str, Math.round((this.w - str.length * 6 + 1) / 2), y)
  }

  circle(cx: number, cy: number, r: number): void {
    for (let a = 0; a < Math.PI * 2; a += 0.02) {
      this.set(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r))
    }
  }

  arc(cx: number, cy: number, r: number, a0: number, a1: number): void {
    for (let a = a0; a < a1; a += 0.02) {
      this.set(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r))
    }
  }

  statusBars(): void {
    for (let i = 0; i < 4; i++) {
      this.rect(0, 30 - i * 6, 1 + i, 4)
      this.rect(this.w - 1 - i, 30 - i * 6, 1 + i, 4)
    }
    this.rect(1, 36, 1, 7)
    this.set(0, 36)
    this.set(2, 36)
    this.set(0, 37)
    this.set(2, 37)
    this.rect(this.w - 3, 36, 3, 7)
    this.set(this.w - 2, 35)
  }

  flush(backlight = 0): void {
    const g = this.canvas.getContext('2d')
    if (!g) return
    const p = this.px
    const grad = g.createLinearGradient(0, 0, 0, this.canvas.height)
    grad.addColorStop(0, backlight ? '#b8e07a' : '#97b566')
    grad.addColorStop(1, backlight ? '#a6d266' : '#86a558')
    g.fillStyle = grad
    g.fillRect(0, 0, this.canvas.width, this.canvas.height)

    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.buf[y * this.w + x]) {
          g.fillStyle = 'rgba(0,0,0,0.12)'
          g.fillRect(x * p + 1.5, y * p + 1.5, p - 0.6, p - 0.6)
          g.fillStyle = '#1c2912'
          g.fillRect(x * p, y * p, p - 0.6, p - 0.6)
        } else {
          g.fillStyle = 'rgba(0,0,0,0.035)'
          g.fillRect(x * p, y * p, p - 0.6, p - 0.6)
        }
      }
    }
    this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture.dispose()
  }
}

export function drawLCDScreen(lcd: NokiaLCD, mode: 'idle' | 'victory'): void {
  lcd.clear()
  if (mode === 'victory') {
    lcd.circle(42, 17, 12)
    lcd.rect(37, 11, 2, 4)
    lcd.rect(46, 11, 2, 4)
    lcd.arc(42, 17, 7, 0.35, Math.PI - 0.35)
    lcd.arc(42, 17.5, 7, 0.4, Math.PI - 0.4)
    lcd.textCenter('3310 WINS', 36)
  } else {
    lcd.statusBars()
    lcd.text('16:52', 50, 1)
    lcd.textCenter('NOKIA', 15)
    lcd.textCenter('Menu', 38)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape()
  const x = -w / 2
  const y = -h / 2
  s.moveTo(x + r, y)
  s.lineTo(x + w - r, y)
  s.quadraticCurveTo(x + w, y, x + w, y + r)
  s.lineTo(x + w, y + h - r)
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  s.lineTo(x + r, y + h)
  s.quadraticCurveTo(x, y + h, x, y + h - r)
  s.lineTo(x, y + r)
  s.quadraticCurveTo(x, y, x + r, y)
  return s
}

function ellipse(rx: number, ry: number): THREE.Shape {
  const s = new THREE.Shape()
  s.absellipse(0, 0, rx, ry, 0, Math.PI * 2, false, 0)
  return s
}

function slab(shape: THREE.Shape, depth: number, bevel: number, mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 32,
  })
  geo.translate(0, 0, bevel)
  const m = new THREE.Mesh(geo, mat)
  m.userData.thickness = depth + bevel * 2
  return m
}

function labelTexture(
  main: string,
  sub = '',
  { w = 128, h = 80, color = '#1b2a55', mainSize = 46, subSize = 26 } = {},
): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  if (g) {
    g.fillStyle = color
    g.textBaseline = 'middle'
    g.font = `bold ${mainSize}px Arial, Helvetica, sans-serif`
    const mw = g.measureText(main).width
    g.font = `bold ${subSize}px Arial, Helvetica, sans-serif`
    const sw = sub ? g.measureText(sub).width + 6 : 0
    const x = (w - mw - sw) / 2
    g.font = `bold ${mainSize}px Arial, Helvetica, sans-serif`
    g.fillText(main, x, h / 2 + 2)
    if (sub) {
      g.font = `bold ${subSize}px Arial, Helvetica, sans-serif`
      g.fillText(sub, x + mw + 6, h / 2 + 4)
    }
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

function sodaCanLabelTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = 512
  const g = c.getContext('2d')
  if (g) {
    g.fillStyle = '#c3122b'
    g.fillRect(0, 0, 1024, 512)
    g.fillStyle = '#ffffff'
    g.beginPath()
    g.moveTo(0, 330)
    for (let x = 0; x <= 1024; x += 8) {
      g.lineTo(x, 330 + Math.sin((x / 1024) * Math.PI * 4) * 30)
    }
    g.lineTo(1024, 380)
    for (let x = 1024; x >= 0; x -= 8) {
      g.lineTo(x, 372 + Math.sin((x / 1024) * Math.PI * 4 + 0.6) * 26)
    }
    g.fill()
    g.font = 'italic 900 170px Georgia, serif'
    g.textBaseline = 'middle'
    for (const x of [80, 592]) g.fillText('Fizz', x, 200)
    g.font = 'bold 34px Arial'
    for (const x of [120, 632]) g.fillText('ORIGINAL · 330 ml', x, 450)
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

function rubberBallTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 256
  const g = c.getContext('2d')
  if (g) {
    g.fillStyle = '#e23b26'
    g.fillRect(0, 0, 512, 256)
    g.fillStyle = '#ffd23a'
    g.fillRect(0, 112, 512, 32)
  }
  const map = new THREE.CanvasTexture(c)
  map.colorSpace = THREE.SRGBColorSpace
  return map
}

// ---------------------------------------------------------------------------
// Object builders
// ---------------------------------------------------------------------------

export interface BuiltObject {
  root: THREE.Group
  model: THREE.Group
  deformableMeshes: THREE.Mesh[]
  H: number
  halfDepth: number
  halfWidth: number
  setScreen?: (mode: 'idle' | 'victory', backlight?: number) => void
  dispose: () => void
}

export function buildProceduralNokia(): BuiltObject {
  const phone = new THREE.Group()
  const FRONT = 1.1

  const body = new THREE.MeshPhysicalMaterial({ color: '#1e2b4f', roughness: 0.42, metalness: 0.05, clearcoat: 0.6, clearcoatRoughness: 0.35 })
  const silver = new THREE.MeshStandardMaterial({ color: '#b7bcc4', metalness: 0.75, roughness: 0.32 })
  const silverLight = new THREE.MeshStandardMaterial({ color: '#d9dde3', metalness: 0.6, roughness: 0.28 })
  const lens = new THREE.MeshPhysicalMaterial({ color: '#232a3a', roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05 })
  const keyMat = new THREE.MeshPhysicalMaterial({ color: '#dde1e7', roughness: 0.35, clearcoat: 0.4 })
  const dark = new THREE.MeshStandardMaterial({ color: '#0a0d14', roughness: 0.8 })

  const L = 5.3
  const W = 2.05
  const r = 1.6
  const waist = 0.3
  const s = new THREE.Shape()
  s.moveTo(-W, -L + r)
  s.quadraticCurveTo(-W + waist, 0.4, -W, L - r)
  s.quadraticCurveTo(-W, L, -W + r, L)
  s.lineTo(W - r, L)
  s.quadraticCurveTo(W, L, W, L - r)
  s.quadraticCurveTo(W - waist, 0.4, W, -L + r)
  s.quadraticCurveTo(W, -L, W - r, -L)
  s.lineTo(-W + r, -L)
  s.quadraticCurveTo(-W, -L, -W, -L + r)

  const bodyGeo = new THREE.ExtrudeGeometry(s, { depth: 1.4, bevelEnabled: true, bevelThickness: 0.4, bevelSize: 0.35, bevelSegments: 8, curveSegments: 48 })
  bodyGeo.translate(0, 0, -0.7)
  phone.add(new THREE.Mesh(bodyGeo, body))

  const put = (m: THREE.Object3D, x: number, y: number, z: number, rz = 0) => {
    m.position.set(x, y, z)
    m.rotation.z = rz
    phone.add(m)
    return m
  }

  const ring = put(slab(roundedRect(3.6, 4.5, 1.3), 0.05, 0.03, silver), 0, 1.15, FRONT - 0.02)
  const ringTop = FRONT - 0.02 + ring.userData.thickness
  const lensM = put(slab(roundedRect(3.2, 2.85, 0.45), 0.03, 0.01, lens), 0, 1.95, ringTop - 0.005)
  const lensTop = ringTop - 0.005 + lensM.userData.thickness

  const lcd = new NokiaLCD()
  const lcdMat = new THREE.MeshStandardMaterial({ map: lcd.texture, emissiveMap: lcd.texture, emissive: '#ffffff', emissiveIntensity: 0.18, roughness: 0.55 })
  put(new THREE.Mesh(new THREE.PlaneGeometry(2.66, 1.52), lcdMat), 0, 2.0, lensTop + 0.003)

  const navi = put(slab(ellipse(0.95, 0.3), 0.08, 0.07, silverLight), 0, 0.05, ringTop - 0.01)
  const naviTop = ringTop - 0.01 + navi.userData.thickness
  put(new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.07), new THREE.MeshStandardMaterial({ color: '#2a7de1', emissive: '#1f6ad1', emissiveIntensity: 0.6 })), 0, 0.05, naviTop + 0.002)

  for (const [x, rz, lbl] of [[-1.15, -0.45, 'C'], [1.15, 0.45, '▲▼']] as const) {
    const k = put(slab(ellipse(0.52, 0.28), 0.06, 0.06, silver), x, -0.5, ringTop - 0.02, rz)
    const lab = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5), new THREE.MeshBasicMaterial({ map: labelTexture(lbl, '', { color: '#26324f', mainSize: lbl === 'C' ? 50 : 30 }), transparent: true }))
    put(lab, x, -0.5, ringTop - 0.02 + k.userData.thickness + 0.002, rz)
  }

  const keys = [
    ['1', 'oo'], ['2', 'abc'], ['3', 'def'],
    ['4', 'ghi'], ['5', 'jkl'], ['6', 'mno'],
    ['7', 'pqrs'], ['8', 'tuv'], ['9', 'wxyz'],
    ['*', '+'], ['0', '_'], ['#', ''],
  ]
  const rows = [-1.35, -2.3, -3.25, -4.2]
  keys.forEach(([main, sub], i) => {
    const col = i % 3
    const row = Math.floor(i / 3)
    const x = (col - 1) * 1.3
    const y = rows[row] + (col === 1 ? -0.08 : 0.06)
    const rz = (1 - col) * 0.16
    const k = put(slab(ellipse(0.56, 0.32), 0.07, 0.06, keyMat), x, y, FRONT - 0.02, rz)
    const lab = new THREE.Mesh(new THREE.PlaneGeometry(0.98, 0.61), new THREE.MeshBasicMaterial({ map: labelTexture(main, sub), transparent: true }))
    put(lab, x, y, FRONT - 0.02 + k.userData.thickness + 0.002, rz)
  })

  for (let i = 0; i < 5; i++) {
    const d = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.04, 12), dark)
    d.rotation.x = Math.PI / 2
    d.position.set(0, 4.35 + i * 0.18, FRONT)
    phone.add(d)
  }

  const logo = labelTexture('NOKIA', '', { w: 256, h: 64, color: '#eef1f6', mainSize: 44 })
  put(new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.48), new THREE.MeshBasicMaterial({ map: logo, transparent: true, toneMapped: false })), 0, 3.75, FRONT + 0.002)

  // Rotate sideways so it lies on its long edge, matching real tests
  const model = new THREE.Group()
  phone.rotation.z = Math.PI / 2
  model.add(phone)

  model.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  phone.position.sub(new THREE.Vector3(center.x, box.min.y, center.z))

  const inner = new THREE.Group()
  inner.position.z = size.z / 2
  inner.add(model)
  const root = new THREE.Group()
  root.add(inner)

  const setScreen = (mode: 'idle' | 'victory', backlight = 0) => {
    drawLCDScreen(lcd, mode)
    lcd.flush(backlight)
    lcdMat.emissiveIntensity = backlight ? 0.55 : 0.18
  }
  setScreen('idle')

  return {
    root,
    model,
    deformableMeshes: [],
    H: size.y,
    halfWidth: size.x / 2,
    halfDepth: size.z / 2,
    setScreen,
    dispose: () => {
      lcd.dispose()
      logo.dispose()
    },
  }
}

export function buildNokiaFromModel(modelScene: THREE.Group): BuiltObject {
  const phone = new THREE.Group()
  const model = modelScene.clone(true)
  phone.add(model)

  phone.updateMatrixWorld(true)
  let box = new THREE.Box3().setFromObject(phone)
  const size = box.getSize(new THREE.Vector3())
  model.scale.multiplyScalar(11.3 / size.y)
  phone.updateMatrixWorld(true)
  box = new THREE.Box3().setFromObject(phone)
  model.position.sub(box.getCenter(new THREE.Vector3()))
  phone.updateMatrixWorld(true)

  let screen: THREE.Mesh | null = null
  const screenMatch = /screen|display|lcd|glass/i
  model.traverse((o) => {
    if (!screen && o instanceof THREE.Mesh && (screenMatch.test(o.name) || screenMatch.test((o.material as THREE.Material)?.name || ''))) {
      screen = o
    }
  })

  const lcd = new NokiaLCD()
  const lcdMat = new THREE.MeshStandardMaterial({ map: lcd.texture, emissiveMap: lcd.texture, emissive: '#ffffff', emissiveIntensity: 0.18, roughness: 0.55 })
  const sb = screen ? new THREE.Box3().setFromObject(screen) : null
  const w = sb ? (sb.max.x - sb.min.x) * 0.92 : 2.66
  const lcdPlane = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 1.75), lcdMat)
  if (sb) {
    lcdPlane.position.set((sb.min.x + sb.max.x) / 2, (sb.min.y + sb.max.y) / 2, sb.max.z + 0.01)
  } else {
    lcdPlane.position.set(0, 2.0, box.max.z + 0.01)
  }
  phone.add(lcdPlane)

  const rootModel = new THREE.Group()
  phone.rotation.z = Math.PI / 2
  rootModel.add(phone)

  rootModel.updateMatrixWorld(true)
  const finalBox = new THREE.Box3().setFromObject(rootModel)
  const finalSize = finalBox.getSize(new THREE.Vector3())
  const finalCenter = finalBox.getCenter(new THREE.Vector3())
  phone.position.sub(new THREE.Vector3(finalCenter.x, finalBox.min.y, finalCenter.z))

  const inner = new THREE.Group()
  inner.position.z = finalSize.z / 2
  inner.add(rootModel)
  const root = new THREE.Group()
  root.add(inner)

  const setScreen = (mode: 'idle' | 'victory', backlight = 0) => {
    drawLCDScreen(lcd, mode)
    lcd.flush(backlight)
    lcdMat.emissiveIntensity = backlight ? 0.55 : 0.18
  }
  setScreen('idle')

  return {
    root,
    model: rootModel,
    deformableMeshes: [],
    H: finalSize.y,
    halfWidth: finalSize.x / 2,
    halfDepth: finalSize.z / 2,
    setScreen,
    dispose: () => {
      lcd.dispose()
    },
  }
}

export function buildSodaCan(): BuiltObject {
  const g = new THREE.Group()
  const R = 3.3
  const alu = new THREE.MeshStandardMaterial({ color: '#d4d7dc', metalness: 1, roughness: 0.25 })
  const labelTex = sodaCanLabelTexture()
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(R, R, 9.8, 48, 36, true),
    new THREE.MeshStandardMaterial({ map: labelTex, metalness: 0.55, roughness: 0.3 }),
  )
  body.position.y = 0.9 + 4.9
  g.add(body)

  const bottom = new THREE.Mesh(
    new THREE.LatheGeometry(
      [
        new THREE.Vector2(0, 0.55),
        new THREE.Vector2(1.6, 0.3),
        new THREE.Vector2(2.5, 0.0),
        new THREE.Vector2(3.0, 0.2),
        new THREE.Vector2(3.3, 0.9),
      ],
      48,
    ),
    alu,
  )
  const top = new THREE.Mesh(
    new THREE.LatheGeometry(
      [
        new THREE.Vector2(R, 10.7),
        new THREE.Vector2(3.1, 11.4),
        new THREE.Vector2(2.7, 11.95),
        new THREE.Vector2(2.72, 12.15),
        new THREE.Vector2(2.55, 12.2),
        new THREE.Vector2(2.45, 11.95),
        new THREE.Vector2(0, 11.9),
      ],
      48,
    ),
    alu,
  )
  bottom.material = alu.clone()
  bottom.material.side = THREE.DoubleSide
  top.material = bottom.material
  g.add(bottom, top)

  const tab = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 0.6), alu)
  tab.position.set(0, 11.97, 0.7)
  g.add(tab)

  return prepareDeformableObject(g, () => labelTex.dispose())
}

export function buildRubberBall(): BuiltObject {
  const tex = rubberBallTexture()
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(3.6, 48, 36),
    new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.45, clearcoat: 0.35, clearcoatRoughness: 0.4 }),
  )
  ball.rotation.x = 0.35
  const g = new THREE.Group()
  g.add(ball)
  return prepareDeformableObject(g, () => tex.dispose())
}

export function buildGlassCube(): BuiltObject {
  const mesh = new THREE.Mesh(
    new RoundedBoxGeometry(5.5, 5.5, 5.5, 4, 0.25),
    new THREE.MeshPhysicalMaterial({
      color: '#e6f6ff',
      roughness: 0.03,
      metalness: 0,
      transmission: 0.95,
      thickness: 3,
      ior: 1.52,
      attenuationColor: new THREE.Color('#bfe8e0'),
      attenuationDistance: 12,
      clearcoat: 1,
      specularIntensity: 1,
    }),
  )
  const g = new THREE.Group()
  g.add(mesh)
  return prepareDeformableObject(g)
}

export function buildTungstenCube(): BuiltObject {
  const mesh = new THREE.Mesh(
    new RoundedBoxGeometry(5, 5, 5, 6, 0.15),
    new THREE.MeshStandardMaterial({ color: '#8e9196', metalness: 1, roughness: 0.3 }),
  )
  const g = new THREE.Group()
  g.add(mesh)
  return prepareDeformableObject(g)
}

/** Bake transformations into vertex arrays so compression deformer works uniformly */
function prepareDeformableObject(builtGroup: THREE.Group, onDispose?: () => void): BuiltObject {
  builtGroup.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(builtGroup)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  builtGroup.position.sub(new THREE.Vector3(center.x, box.min.y, center.z))

  const model = new THREE.Group()
  model.add(builtGroup)
  model.updateMatrixWorld(true)

  const inv = model.matrixWorld.clone().invert()
  const deformableMeshes: THREE.Mesh[] = []
  const meshes: THREE.Mesh[] = []
  model.traverse((o) => {
    if (o instanceof THREE.Mesh) meshes.push(o)
  })

  for (const m of meshes) {
    const rel = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)
    m.geometry = m.geometry.clone().applyMatrix4(rel)
    m.position.set(0, 0, 0)
    m.quaternion.identity()
    m.scale.set(1, 1, 1)
    m.userData.orig = m.geometry.attributes.position.array.slice()
    model.add(m)
    deformableMeshes.push(m)
  }
  builtGroup.removeFromParent()

  const inner = new THREE.Group()
  inner.position.z = size.z / 2
  inner.add(model)
  const root = new THREE.Group()
  root.add(inner)

  return {
    root,
    model,
    deformableMeshes,
    H: size.y,
    halfWidth: size.x / 2,
    halfDepth: size.z / 2,
    dispose: () => {
      onDispose?.()
      for (const m of deformableMeshes) {
        m.geometry.dispose()
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Deformation & Shattering
// ---------------------------------------------------------------------------

export function applyCompression(obj: BuiltObject, c: number, def: PressObjectDef): void {
  if (!obj.deformableMeshes.length) return
  const H = obj.H
  const s = Math.max(0.01, 1 - c)
  const behavior = def.behavior

  for (const mesh of obj.deformableMeshes) {
    const o = mesh.userData.orig as Float32Array
    if (!o) continue
    const pos = mesh.geometry.attributes.position
    const a = pos.array as Float32Array
    for (let i = 0; i < a.length; i += 3) {
      const x0 = o[i]
      const y0 = o[i + 1]
      const z0 = o[i + 2]
      const u = Math.min(1, Math.max(0, y0 / H))
      let r: number
      let y = y0 * s

      if (behavior === 'elastic') {
        r = 1 + (1 / Math.sqrt(Math.max(s, 0.05)) - 1) * (0.5 + 0.5 * Math.sin(Math.PI * u))
      } else {
        const ang = Math.atan2(z0, x0)
        const cc = Math.max(c, 0)
        const folds = def.folds ?? 5
        const bulge = def.bulge ?? 0.35
        const crumple = def.crumple ?? 0.15
        const fold = Math.sin(u * Math.PI * 2 * folds + ang * 3) * 0.6 + Math.sin(ang * 5 + y0 * 0.9 + x0 * 0.7) * 0.4
        r = 1 + cc * bulge * Math.sin(Math.PI * u) + cc * cc * crumple * fold
        y += cc * H * 0.04 * crumple * Math.sin(ang * 4 + u * 9)
      }

      a[i] = x0 * r
      a[i + 1] = y
      a[i + 2] = z0 * r
    }
    pos.needsUpdate = true
    mesh.geometry.computeVertexNormals()
    mesh.geometry.computeBoundingSphere()
  }
}

export function shatterObject(
  obj: BuiltObject,
  def: PressObjectDef,
  debris: DebrisSystem,
  fx: PressFX,
  scene: THREE.Scene,
  rng: Rng,
): void {
  obj.root.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(obj.model)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())

  let material: THREE.Material | undefined
  obj.model.traverse((o) => {
    if (!material && o instanceof THREE.Mesh) {
      material = Array.isArray(o.material) ? o.material[0] : o.material
    }
  })

  const n = def.fragments ?? 45
  const unit = Math.cbrt((size.x * size.y * size.z) / n)
  for (let i = 0; i < n; i++) {
    const geo =
      def.fragmentShape === 'shard'
        ? new THREE.TetrahedronGeometry(unit * (0.5 + rng.next() * 0.6))
        : new THREE.DodecahedronGeometry(unit * (0.35 + rng.next() * 0.35))
    geo.scale(0.6 + rng.next() * 0.8, 0.3 + rng.next() * 0.8, 0.6 + rng.next() * 0.8)
    const frag = new THREE.Mesh(geo, material ?? new THREE.MeshStandardMaterial({ color: 0xffffff }))
    frag.position.set(
      center.x + (rng.next() - 0.5) * size.x,
      box.min.y + (0.05 + rng.next() * 0.85) * size.y,
      center.z + (rng.next() - 0.5) * size.z,
    )
    frag.rotation.set(rng.next() * 6, rng.next() * 6, rng.next() * 6)
    scene.add(frag)

    const out = frag.position.clone().sub(center).setY(0).normalize()
    const vel = out.multiplyScalar(80 + rng.next() * 340).add(new THREE.Vector3(0, -40 + rng.next() * 220, 0))
    const angVel = new THREE.Vector3((rng.next() - 0.5) * 50, (rng.next() - 0.5) * 50, (rng.next() - 0.5) * 50)
    debris.add(frag, vel, angVel, { bounce: 0.35, owned: true })
  }

  fx.dust(center, 40, def.dustColor ?? [0.85, 0.9, 0.95], 140)
  fx.sparks(center, 20, 200)
  obj.root.visible = false
}
