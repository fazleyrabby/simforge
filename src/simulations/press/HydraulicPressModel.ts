import * as THREE from 'three'
import { Rng } from '../core/random'
import type { DebrisSystem, PressFX } from './PressFX'

const TAU = Math.PI * 2

function stripeCanvas(width: number, height: number, stripes: number, rng: Rng): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  const g = c.getContext('2d')
  if (!g) return c

  g.fillStyle = '#efc416'
  g.fillRect(0, 0, width, height)
  g.fillStyle = '#131313'
  const period = width / stripes
  for (let i = -Math.ceil(height / period) - 1; i <= stripes + 1; i++) {
    const x = i * period
    g.beginPath()
    g.moveTo(x, height)
    g.lineTo(x + period / 2, height)
    g.lineTo(x + period / 2 + height, 0)
    g.lineTo(x + height, 0)
    g.closePath()
    g.fill()
  }

  // Grime and scuffs
  for (let i = 0; i < 2000; i++) {
    g.fillStyle = `rgba(0,0,0,${rng.next() * 0.09})`
    g.fillRect(rng.next() * width, rng.next() * height, 1 + rng.next() * 4, 1 + rng.next() * 2)
  }
  for (let i = 0; i < 200; i++) {
    g.fillStyle = `rgba(255,255,255,${rng.next() * 0.12})`
    g.fillRect(rng.next() * width, rng.next() * height, 2 + rng.next() * 12, 1)
  }
  for (const y of [0, height - 6]) {
    const gr = g.createLinearGradient(0, y, 0, y + 6)
    gr.addColorStop(0, 'rgba(0,0,0,0.35)')
    gr.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = gr
    g.fillRect(0, y, width, 6)
  }
  return c
}

interface CrackBranch {
  x: number
  y: number
  a: number
  life: number
  w: number
}

class CrackPainter {
  readonly c: HTMLCanvasElement
  readonly g: CanvasRenderingContext2D | null
  readonly tex: THREE.CanvasTexture
  private cracks: CrackBranch[] = []
  private dirty = false

  constructor(canvas: HTMLCanvasElement, texture: THREE.CanvasTexture) {
    this.c = canvas
    this.g = canvas.getContext('2d')
    this.tex = texture
  }

  seed(n: number, rng: Rng): void {
    for (let i = 0; i < n; i++) {
      const fromTop = rng.next() < 0.5
      this.cracks.push({
        x: rng.next() * this.c.width,
        y: fromTop ? 0 : this.c.height,
        a: (fromTop ? Math.PI / 2 : -Math.PI / 2) + (rng.next() - 0.5),
        life: 25 + rng.next() * 35,
        w: 2 + rng.next() * 2,
      })
    }
  }

  grow(steps: number, rng: Rng): void {
    const g = this.g
    if (!g) return
    const W = this.c.width
    const H = this.c.height
    for (let s = 0; s < steps; s++) {
      for (const k of this.cracks) {
        if (k.life <= 0) continue
        const len = 4 + rng.next() * 9
        k.a += (rng.next() - 0.5) * 1.4
        const nx = k.x + Math.cos(k.a) * len
        const ny = k.y + Math.sin(k.a) * len

        for (const off of [0, W, -W]) {
          g.strokeStyle = 'rgba(255,255,255,0.25)'
          g.lineWidth = 1
          g.beginPath()
          g.moveTo(k.x + off + 1, k.y + 1)
          g.lineTo(nx + off + 1, ny + 1)
          g.stroke()

          g.strokeStyle = '#050505'
          g.lineWidth = k.w
          g.beginPath()
          g.moveTo(k.x + off, k.y)
          g.lineTo(nx + off, ny)
          g.stroke()
        }
        k.x = nx
        k.y = Math.max(0, Math.min(H, ny))
        k.life--
        k.w = Math.max(0.8, k.w * 0.97)

        if (rng.next() < 0.06) {
          this.cracks.push({
            ...k,
            a: k.a + (rng.next() - 0.5) * 2.4,
            life: k.life * 0.6,
            w: k.w * 0.7,
          })
        }
      }
    }
    this.dirty = true
  }

  flush(): void {
    if (this.dirty) {
      this.tex.needsUpdate = true
      this.dirty = false
    }
  }

  clear(): void {
    this.cracks = []
    this.dirty = false
  }
}

function cyl(r: number, h: number, mat: THREE.Material, seg = 36, hSeg = 1): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg, hSeg), mat)
}

function box(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
}

function wedge(r: number, h: number, start: number, len: number, sideMat: THREE.Material, capMat: THREE.Material, cutMat: THREE.Material): THREE.Group {
  const g = new THREE.Group()
  const seg = Math.max(4, Math.round((48 * len) / TAU))
  const geo = new THREE.CylinderGeometry(r, r, h, seg, 1, false, start, len)
  const uv = geo.attributes.uv
  for (let i = 0; i < (seg + 1) * 2; i++) {
    uv.setX(i, (start + uv.getX(i) * len) / TAU)
  }
  g.add(new THREE.Mesh(geo, [sideMat, capMat, capMat]))
  for (const a of [start, start + len]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(r, h), cutMat)
    p.rotation.y = a - Math.PI / 2
    p.position.set((Math.sin(a) * r) / 2, 0, (Math.cos(a) * r) / 2)
    g.add(p)
  }
  g.userData.midAngle = start + len / 2
  return g
}

export class HydraulicPressModel {
  readonly group = new THREE.Group()
  readonly baseTop = 4
  readonly anvilTop = 12
  readonly restY = 27

  ramY = 27
  alarm = false
  broken = false
  brokenT = 0
  crownFalling = false
  crownW = 0

  private plateCanvas!: HTMLCanvasElement
  private anvilCanvas!: HTMLCanvasElement
  private plateTex!: THREE.CanvasTexture
  private anvilTex!: THREE.CanvasTexture
  private plateCracks!: CrackPainter
  private anvilCracks!: CrackPainter
  private anvilSeeded = false

  // Gauge canvas
  private gaugeCanvas!: HTMLCanvasElement
  private gaugeTex!: THREE.CanvasTexture
  private gaugeCtx!: CanvasRenderingContext2D | null
  private displayedForce = 0

  // Meshes & groups
  crown!: THREE.Group
  ram!: THREE.Group
  flange!: THREE.Mesh
  gland!: THREE.Mesh
  beaconDome!: THREE.Mesh
  beaconLight!: THREE.PointLight
  puddle!: THREE.Mesh
  colRUp!: THREE.Mesh
  columns: { mesh: THREE.Mesh; dir: number; y0: number; h: number }[] = []
  bolts: THREE.Mesh[] = []
  plateWedges: THREE.Group[] = []
  anvilPieces: THREE.Group[] = []
  hoseEnds: { pos: THREE.Vector3; dir: THREE.Vector3 }[] = []

  private materials: Record<string, THREE.Material> = {}
  private rng: Rng

  constructor(rng: Rng) {
    this.rng = rng
    this.build()
  }

  private build(): void {
    const rng = this.rng
    this.plateCanvas = stripeCanvas(1024, 128, 10, rng)
    this.anvilCanvas = stripeCanvas(1024, 256, 11, rng)

    const createTex = (c: HTMLCanvasElement) => {
      const t = new THREE.CanvasTexture(c)
      t.colorSpace = THREE.SRGBColorSpace
      t.wrapS = THREE.RepeatWrapping
      t.anisotropy = 4
      return t
    }

    this.plateTex = createTex(this.plateCanvas)
    this.anvilTex = createTex(this.anvilCanvas)
    this.plateCracks = new CrackPainter(this.plateCanvas, this.plateTex)
    this.anvilCracks = new CrackPainter(this.anvilCanvas, this.anvilTex)

    // Build analog gauge canvas
    this.gaugeCanvas = document.createElement('canvas')
    this.gaugeCanvas.width = 256
    this.gaugeCanvas.height = 256
    this.gaugeCtx = this.gaugeCanvas.getContext('2d')
    this.gaugeTex = new THREE.CanvasTexture(this.gaugeCanvas)
    this.gaugeTex.colorSpace = THREE.SRGBColorSpace
    this.drawGauge(0, 100)

    const M = {
      paint: new THREE.MeshStandardMaterial({ color: '#343a43', metalness: 0.35, roughness: 0.55 }),
      barrel: new THREE.MeshStandardMaterial({ color: '#4a525e', metalness: 0.5, roughness: 0.4 }),
      darkSteel: new THREE.MeshStandardMaterial({ color: '#3b3f45', metalness: 0.85, roughness: 0.45 }),
      steel: new THREE.MeshStandardMaterial({ color: '#b8bcc2', metalness: 0.95, roughness: 0.25 }),
      chrome: new THREE.MeshStandardMaterial({ color: '#f4f6f8', metalness: 1, roughness: 0.08 }),
      cut: new THREE.MeshStandardMaterial({ color: '#6d7178', metalness: 0.9, roughness: 0.7, side: THREE.DoubleSide }),
      hose: new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.6 }),
      brass: new THREE.MeshStandardMaterial({ color: '#c9a54a', metalness: 1, roughness: 0.3 }),
      pump: new THREE.MeshStandardMaterial({ color: '#2b4f73', metalness: 0.3, roughness: 0.5 }),
      plateSide: new THREE.MeshStandardMaterial({ map: this.plateTex, metalness: 0.2, roughness: 0.45 }),
      anvilSide: new THREE.MeshStandardMaterial({ map: this.anvilTex, metalness: 0.2, roughness: 0.5 }),
      beacon: new THREE.MeshStandardMaterial({ color: '#5a0a0a', emissive: '#ff2200', emissiveIntensity: 0, roughness: 0.2, transparent: true, opacity: 0.9 }),
      gaugeMat: new THREE.MeshBasicMaterial({ map: this.gaugeTex }),
    }
    this.materials = M

    // 1. Base
    const base = box(44, this.baseTop, 28, M.paint)
    base.position.y = this.baseTop / 2
    this.group.add(base)

    const bandTex = new THREE.CanvasTexture(stripeCanvas(512, 32, 14, rng))
    bandTex.colorSpace = THREE.SRGBColorSpace
    const band = new THREE.Mesh(new THREE.PlaneGeometry(44, 1.4), new THREE.MeshStandardMaterial({ map: bandTex, roughness: 0.6 }))
    band.position.set(0, 2, 14.02)
    this.group.add(band)

    for (const x of [-19, 19]) {
      for (const z of [-11, 11]) {
        const f = cyl(1.8, 0.6, M.darkSteel, 16)
        f.position.set(x, 0.3, z)
        this.group.add(f)
      }
    }

    // 2. Columns
    const span = [this.baseTop, 52]
    this.columns = []
    const addCol = (x: number, y0: number, y1: number, dir: number) => {
      const h = y1 - y0
      const m = cyl(2.2, h, M.steel, 28, Math.round(h / 2))
      m.position.set(x, (y0 + y1) / 2, 0)
      m.userData.orig = m.geometry.attributes.position.array.slice()
      this.group.add(m)
      this.columns.push({ mesh: m, dir, y0, h })
      return m
    }
    addCol(-16, span[0], span[1], -1)
    addCol(16, span[0], 30, 1)
    this.colRUp = addCol(16, 30, span[1], 1)

    for (const x of [-16, 16]) {
      const nut = cyl(3.3, 1.6, M.darkSteel, 6)
      nut.position.set(x, this.baseTop + 0.8, 0)
      this.group.add(nut)
    }
    const nutUp = cyl(3.3, 1.6, M.darkSteel, 6)
    nutUp.position.set(0, 22 / 2 - 0.8, 0)
    this.colRUp.add(nutUp)
    const nutUpL = cyl(3.3, 1.6, M.darkSteel, 6)
    nutUpL.position.set(-16, 51.2, 0)
    this.group.add(nutUpL)

    // 3. Crown
    const P = (this.crown = new THREE.Group())
    P.position.set(-16, 52, 0)
    this.group.add(P)
    const at = (m: THREE.Object3D, x: number, y: number, z: number) => {
      m.position.set(x + 16, y - 52, z)
      P.add(m)
      return m
    }

    at(box(42, 8, 12, M.paint), 0, 56, 0)
    at(box(42.4, 1, 12.4, M.darkSteel), 0, 52.5, 0)
    at(box(42.4, 1, 12.4, M.darkSteel), 0, 59.5, 0)
    for (const x of [-9, 9]) at(box(1.2, 7, 12.8, M.darkSteel), x, 56, 0)

    at(cyl(6.5, 18, M.barrel, 36), 0, 43, 0)
    at(cyl(7.4, 1.4, M.darkSteel, 36), 0, 51.3, 0)
    this.gland = at(cyl(7.2, 1.6, M.darkSteel, 36) as THREE.Mesh, 0, 34.8, 0) as THREE.Mesh

    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU
      at(cyl(0.45, 0.6, M.steel, 6), Math.sin(a) * 6.6, 34.0, Math.cos(a) * 6.6)
    }

    const ports: THREE.Mesh[] = []
    for (const z of [2.3, -2.3]) {
      const p = at(cyl(0.9, 2.4, M.brass, 16), 7.4, 47, z) as THREE.Mesh
      p.rotation.z = Math.PI / 2
      ports.push(p)
    }

    at(cyl(1.4, 0.8, M.darkSteel, 20), 16, 60.4, 3)
    this.beaconDome = at(new THREE.Mesh(new THREE.SphereGeometry(1.25, 20, 10, 0, TAU, 0, Math.PI / 2), M.beacon), 16, 60.8, 3) as THREE.Mesh
    this.beaconLight = new THREE.PointLight('#ff2a10', 0, 120, 1.5)
    this.beaconLight.position.set(0, 1.5, 0)
    this.beaconDome.add(this.beaconLight)

    // 4. Ram
    const R = (this.ram = new THREE.Group())
    this.group.add(R)

    const cuts = [0]
    while (cuts[cuts.length - 1] < TAU - 1.1) {
      cuts.push(cuts[cuts.length - 1] + 0.6 + rng.next() * 0.5)
    }
    cuts.push(TAU)
    const off = rng.next() * TAU
    this.plateWedges = []
    for (let i = 0; i < cuts.length - 1; i++) {
      const w = wedge(8.5, 3.5, cuts[i] + off, cuts[i + 1] - cuts[i], M.plateSide, M.darkSteel, M.cut)
      w.position.y = 1.75
      R.add(w)
      this.plateWedges.push(w)
    }

    this.flange = cyl(9.3, 2, M.steel, 48)
    this.flange.position.y = 4.5
    R.add(this.flange)
    this.bolts = []
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + 0.2
      const b = cyl(0.75, 0.9, M.darkSteel, 6)
      b.position.set(Math.sin(a) * 7.9, 5.95, Math.cos(a) * 7.9)
      b.userData.angle = a
      R.add(b)
      this.bolts.push(b)
    }

    const collar = cyl(5.4, 1.2, M.steel, 36)
    collar.position.y = 6.1
    R.add(collar)
    const rod = cyl(4.5, 32, M.chrome, 36)
    rod.position.y = 5.5 + 16
    R.add(rod)

    // 5. Anvil
    const h = this.anvilTop - this.baseTop
    const cutsAnvil = [0, 1.8 + rng.next() * 0.6, 3.9 + rng.next() * 0.6, TAU]
    this.anvilPieces = []
    for (let i = 0; i < 3; i++) {
      const w = wedge(9.5, h, cutsAnvil[i] + off, cutsAnvil[i + 1] - cutsAnvil[i], M.anvilSide, M.darkSteel, M.cut)
      w.position.y = this.baseTop + h / 2
      this.group.add(w)
      this.anvilPieces.push(w)
    }

    // 6. Hydraulics & Gauge
    const pump = box(10, 14, 10, M.pump)
    pump.position.set(31, 7, -5)
    this.group.add(pump)

    const motor = cyl(3, 8, M.darkSteel, 24)
    motor.rotation.z = Math.PI / 2
    motor.position.set(31, 17, -5)
    this.group.add(motor)

    // Analog dial gauge face
    const gaugeFace = cyl(2.2, 0.4, M.darkSteel, 28)
    gaugeFace.rotation.x = Math.PI / 2
    gaugeFace.position.set(31, 9, 0.2)
    this.group.add(gaugeFace)

    const gaugeDial = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 3.8), M.gaugeMat)
    gaugeDial.position.set(31, 9, 0.42)
    this.group.add(gaugeDial)

    // Hoses
    this.crown.updateMatrixWorld(true)
    this.hoseEnds = []
    ports.forEach((port, i) => {
      const s = port.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(1.2, 0, 0))
      const pts = [
        s,
        s.clone().add(new THREE.Vector3(5, 0.5, 0.3)),
        new THREE.Vector3(21, 42, s.z + 1.5),
        new THREE.Vector3(28.5, 28, s.z),
        new THREE.Vector3(29 + i * 3, 16, -3 - i * 2),
        new THREE.Vector3(29 + i * 3, 14, -3 - i * 2),
      ]
      const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.6, 8), M.hose)
      this.group.add(tube)
      this.hoseEnds.push({ pos: s.clone(), dir: new THREE.Vector3(0.2, 0.25, i ? -0.6 : 0.6) })
    })

    // Oil Puddle
    const puddleTex = (() => {
      const c = document.createElement('canvas')
      c.width = 256
      c.height = 256
      const g = c.getContext('2d')
      if (g) {
        g.fillStyle = '#fff'
        for (let i = 0; i < 14; i++) {
          g.beginPath()
          g.arc(128 + (rng.next() - 0.5) * 120, 128 + (rng.next() - 0.5) * 120, 30 + rng.next() * 40, 0, TAU)
          g.fill()
        }
      }
      return new THREE.CanvasTexture(c)
    })()

    this.puddle = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshStandardMaterial({
        color: '#1e1002',
        metalness: 0.4,
        roughness: 0.04,
        alphaMap: puddleTex,
        transparent: true,
        depthWrite: false,
      }),
    )
    this.puddle.rotation.x = -Math.PI / 2
    this.puddle.position.set(0, this.baseTop + 0.03, 2)
    this.puddle.scale.setScalar(0.001)
    this.group.add(this.puddle)

    this.setRam(this.restY)
  }

  drawGauge(force: number, capacity: number): void {
    const g = this.gaugeCtx
    if (!g) return
    const W = this.gaugeCanvas.width
    const H = this.gaugeCanvas.height
    const cx = W / 2
    const cy = H / 2
    const r = W * 0.44

    g.clearRect(0, 0, W, H)

    // Bezel
    g.fillStyle = '#1c2229'
    g.beginPath()
    g.arc(cx, cy, r + 6, 0, TAU)
    g.fill()

    // Face
    g.fillStyle = '#f0f3f6'
    g.beginPath()
    g.arc(cx, cy, r, 0, TAU)
    g.fill()

    // Overload arc (red segment)
    const startAng = 0.75 * Math.PI
    const endAng = 2.25 * Math.PI
    const totalAng = endAng - startAng

    g.strokeStyle = '#e63946'
    g.lineWidth = 6
    g.beginPath()
    g.arc(cx, cy, r - 12, startAng + totalAng * 0.85, endAng)
    g.stroke()

    // Ticks & labels
    g.strokeStyle = '#2b303a'
    g.fillStyle = '#2b303a'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.font = 'bold 16px monospace'

    const majorSteps = 5
    for (let i = 0; i <= majorSteps; i++) {
      const frac = i / majorSteps
      const a = startAng + frac * totalAng
      const x1 = cx + Math.cos(a) * (r - 4)
      const y1 = cy + Math.sin(a) * (r - 4)
      const x2 = cx + Math.cos(a) * (r - 16)
      const y2 = cy + Math.sin(a) * (r - 16)

      g.lineWidth = 2.5
      g.beginPath()
      g.moveTo(x1, y1)
      g.lineTo(x2, y2)
      g.stroke()

      const val = Math.round(frac * capacity)
      const tx = cx + Math.cos(a) * (r - 28)
      const ty = cy + Math.sin(a) * (r - 28)
      g.fillText(String(val), tx, ty)
    }

    // Dial label
    g.font = 'bold 14px sans-serif'
    g.fillStyle = '#4a5568'
    g.fillText('TONS', cx, cy + 30)

    // Needle
    const clampedVal = Math.min(capacity * 1.15, Math.max(0, force))
    const needleFrac = clampedVal / Math.max(1, capacity)
    const needleAng = startAng + needleFrac * totalAng

    g.strokeStyle = '#d90429'
    g.lineWidth = 3.5
    g.beginPath()
    g.moveTo(cx, cy)
    g.lineTo(cx + Math.cos(needleAng) * (r - 14), cy + Math.sin(needleAng) * (r - 14))
    g.stroke()

    // Center pivot
    g.fillStyle = '#2b303a'
    g.beginPath()
    g.arc(cx, cy, 7, 0, TAU)
    g.fill()

    this.gaugeTex.needsUpdate = true
  }

  updateGauge(force: number, capacity: number, dt: number): void {
    this.displayedForce += (force - this.displayedForce) * Math.min(1, dt * 18)
    this.drawGauge(this.displayedForce, capacity)
  }

  setRam(y: number): void {
    this.ramY = y
    this.ram.position.y = y
  }

  private bowColumns(amount: number): void {
    for (const c of this.columns) {
      if (c.mesh.parent !== this.group) continue
      const pos = c.mesh.geometry.attributes.position
      const o = c.mesh.userData.orig as Float32Array
      if (!o) continue
      for (let i = 0; i < pos.count; i++) {
        const ly = o[i * 3 + 1]
        const u = (c.mesh.position.y + ly - this.baseTop) / 48
        pos.setX(i, o[i * 3] + c.dir * amount * Math.sin(Math.PI * u))
      }
      pos.needsUpdate = true
      c.mesh.geometry.computeVertexNormals()
    }
  }

  beginStrain(): void {
    this.alarm = true
    this.plateCracks.seed(5, this.rng)
  }

  updateStrain(k: number, dt: number, fx: PressFX, subjectHw: number, subjectHd: number): void {
    const rng = this.rng
    const vib = 0.03 + k * k * 0.25
    this.ram.position.x = (rng.next() - 0.5) * vib * 2
    this.ram.position.z = (rng.next() - 0.5) * vib * 2
    this.crown.position.x = -16 + (rng.next() - 0.5) * vib * 0.8
    this.bowColumns(k * k * 1.4)

    this.plateCracks.grow(rng.next() < k * 1.5 ? 1 : 0, rng)
    if (k > 0.35 && !this.anvilSeeded) {
      this.anvilSeeded = true
      this.anvilCracks.seed(4, rng)
    }
    if (k > 0.35) {
      this.anvilCracks.grow(rng.next() < k ? 1 : 0, rng)
    }
    this.plateCracks.flush()
    this.anvilCracks.flush()

    if (rng.next() < dt * (4 + k * 30)) {
      const p = new THREE.Vector3(
        (rng.next() - 0.5) * subjectHw * 2,
        this.ramY,
        (rng.next() - 0.5) * subjectHd * 2 + 0.3,
      )
      fx.sparks(p, Math.round(6 + k * 25), 120 + k * 250)
    }

    if (k > 0.45 && rng.next() < dt * 20 * k) {
      const a = rng.next() * TAU
      const gp = this.gland.getWorldPosition(new THREE.Vector3())
      fx.fluid(
        gp.add(new THREE.Vector3(Math.sin(a) * 6.8, -0.8, Math.cos(a) * 6.8)),
        new THREE.Vector3(Math.sin(a), -1, Math.cos(a)),
        2,
        30,
        { spread: 0.4 },
      )
    }

    if (k > 0.6 && rng.next() < dt * 8) {
      for (const h of this.hoseEnds) {
        fx.smoke(h.pos, 1, { color: [0.9, 0.9, 0.9], size: 1.5, sizeEnd: 7, life: 1.2, rise: 20, spread: 0.5, alpha: 0.25 })
      }
    }
  }

  launchBolt(debris: DebrisSystem, fx: PressFX): void {
    const b = this.bolts.pop()
    if (!b) return
    const a = b.userData.angle as number
    const wp = b.getWorldPosition(new THREE.Vector3())
    const rng = this.rng
    const vel = new THREE.Vector3(
      Math.sin(a) * (150 + rng.next() * 250),
      250 + rng.next() * 250,
      Math.cos(a) * (150 + rng.next() * 250),
    )
    const angVel = new THREE.Vector3((rng.next() - 0.5) * 60, (rng.next() - 0.5) * 60, (rng.next() - 0.5) * 60)
    debris.add(b, vel, angVel)
    fx.sparks(wp, 12, 200)
  }

  explode(fx: PressFX, debris: DebrisSystem): void {
    this.broken = true
    this.brokenT = 0
    this.bowColumns(0)
    const rng = this.rng
    const center = new THREE.Vector3(0, this.ramY, 0)

    for (const w of this.plateWedges) {
      const a = w.userData.midAngle as number
      const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a))
      debris.add(
        w,
        dir.multiplyScalar(280 + rng.next() * 370).add(new THREE.Vector3(0, 60 + rng.next() * 260, 0)),
        new THREE.Vector3((rng.next() - 0.5) * 28, (rng.next() - 0.5) * 28, (rng.next() - 0.5) * 28),
        { bounce: 0.35 },
      )
    }

    while (this.bolts.length > 0) {
      this.launchBolt(debris, fx)
    }

    for (const p of this.anvilPieces) {
      const a = p.userData.midAngle as number
      const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a))
      debris.add(
        p,
        dir.multiplyScalar(70 + rng.next() * 100).add(new THREE.Vector3(0, 90 + rng.next() * 90, 0)),
        new THREE.Vector3((rng.next() - 0.5) * 6, (rng.next() - 0.5) * 4, (rng.next() - 0.5) * 6),
        { bounce: 0.2 },
      )
    }

    // Right upper column snaps
    debris.add(
      this.colRUp,
      new THREE.Vector3(120 + rng.next() * 100, 80 + rng.next() * 80, (rng.next() - 0.5) * 100),
      new THREE.Vector3((rng.next() - 0.5) * 2, (rng.next() - 0.5) * 2, -4 + rng.next() * 2),
      { bounce: 0.25 },
    )

    this.crown.position.x = -16
    this.crown.attach(this.ram)
    this.crownW = 0
    this.crownFalling = true

    const stump = new THREE.Vector3(16, 30, 0)
    fx.sparks(stump, 60, 350)
    fx.sparks(center, 280, 600, { up: 0.6 })
    fx.sparks(new THREE.Vector3(0, this.anvilTop, 0), 100, 380)
    fx.smoke(center, 35, { color: [0.28, 0.28, 0.3], size: 5, sizeEnd: 24, life: 4, rise: 16, spread: 6, alpha: 0.5 })
    fx.dust(new THREE.Vector3(0, this.anvilTop, 0), 50, [0.6, 0.58, 0.55], 160)

    const gp = this.gland.getWorldPosition(new THREE.Vector3())
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * TAU
      fx.fluid(
        gp.clone().add(new THREE.Vector3(Math.sin(a) * 7, -0.6, Math.cos(a) * 7)),
        new THREE.Vector3(Math.sin(a), (rng.next() - 0.5) * 0.7, Math.cos(a)),
        5,
        360,
        { spread: 0.25 },
      )
    }
  }

  update(dt: number, time: number, fx: PressFX): void {
    if (this.alarm) {
      const on = Math.sin(time * 14) > 0
      const beaconMat = this.materials.beacon as THREE.MeshStandardMaterial
      beaconMat.emissiveIntensity = on ? 8 : 0.3
      this.beaconLight.intensity = on ? 800 : 0
    }

    if (!this.broken) return
    const t = (this.brokenT += dt)
    const rng = this.rng

    if (this.crownFalling) {
      this.crownW -= 4 * dt
      this.crown.rotation.z += this.crownW * dt
      if (this.crown.rotation.z < -0.15) {
        this.crown.rotation.z = -0.15
        if (Math.abs(this.crownW) > 0.08) {
          this.crownW = -this.crownW * 0.3
        } else {
          this.crownFalling = false
        }
      }
    }

    const jet = Math.exp(-t / 3.5)
    for (const h of this.hoseEnds) {
      if (rng.next() < 0.9) {
        fx.fluid(h.pos, h.dir, Math.round(6 * jet) + 1, 260 * jet + 60, { spread: 0.18, size: 0.45 })
      }
    }

    if (rng.next() < dt * 25) {
      const a = rng.next() * TAU
      const gp = this.gland.getWorldPosition(new THREE.Vector3())
      fx.fluid(gp.add(new THREE.Vector3(Math.sin(a) * 6.8, -0.8, Math.cos(a) * 6.8)), new THREE.Vector3(0, -1, 0), 1, 10, { spread: 0.1 })
    }

    if (rng.next() < dt * 12 * Math.exp(-t / 6)) {
      fx.smoke(
        new THREE.Vector3((rng.next() - 0.5) * 8, this.anvilTop + 4, (rng.next() - 0.5) * 8),
        1,
        { color: [0.3, 0.3, 0.32], size: 4, sizeEnd: 20, life: 4, rise: 14, spread: 2, alpha: 0.35 },
      )
    }

    if (t < 2.5 && rng.next() < dt * 10) {
      fx.sparks(new THREE.Vector3(16, 30, 0), 6, 180)
    }

    const s = Math.min(15, 1 + t * 4) * (1 - Math.exp(-t * 0.6))
    this.puddle.scale.set(s, s * 0.8, 1)
  }

  dispose(): void {
    this.plateTex.dispose()
    this.anvilTex.dispose()
    this.gaugeTex.dispose()
    for (const mat of Object.values(this.materials)) {
      mat.dispose()
    }
  }
}
