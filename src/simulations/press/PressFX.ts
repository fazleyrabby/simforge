import * as THREE from 'three'
import { Rng } from '../core/random'

function createSoftTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const g = c.getContext('2d')
  if (g) {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.35, 'rgba(255,255,255,0.8)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 64, 64)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

const VERTEX_SHADER = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uScale;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uMap;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor, a);
  }
`

interface Particle {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  life: number
  max: number
  s0: number
  s1: number
  r: number
  g: number
  b: number
  a0: number
  grav: number
  drag: number
  floor: number
}

export class ParticleSystem {
  readonly max: number
  readonly points: THREE.Points
  private readonly list: Particle[] = []
  private readonly pos: Float32Array
  private readonly col: Float32Array
  private readonly size: Float32Array
  private readonly alpha: Float32Array
  private readonly geo: THREE.BufferGeometry
  private readonly mat: THREE.ShaderMaterial
  private readonly texture: THREE.CanvasTexture

  constructor(scene: THREE.Scene, { max = 2500, additive = false, texture }: { max?: number; additive?: boolean; texture?: THREE.CanvasTexture } = {}) {
    this.max = max
    this.pos = new Float32Array(max * 3)
    this.col = new Float32Array(max * 3)
    this.size = new Float32Array(max)
    this.alpha = new Float32Array(max)

    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage))

    this.texture = texture ?? createSoftTexture()
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uMap: { value: this.texture },
        uScale: { value: 600 },
      },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    })

    this.points = new THREE.Points(this.geo, this.mat)
    this.points.frustumCulled = false
    this.points.renderOrder = additive ? 4 : 3
    scene.add(this.points)
  }

  setScale(scale: number): void {
    this.mat.uniforms.uScale.value = scale
  }

  emit(p: {
    pos: THREE.Vector3
    vel?: THREE.Vector3
    life?: number
    size?: number
    sizeEnd?: number
    color: [number, number, number]
    alpha?: number
    gravity?: number
    drag?: number
    floor?: number
  }): void {
    if (this.list.length >= this.max) {
      this.list.shift()
    }
    this.list.push({
      x: p.pos.x,
      y: p.pos.y,
      z: p.pos.z,
      vx: p.vel?.x ?? 0,
      vy: p.vel?.y ?? 0,
      vz: p.vel?.z ?? 0,
      life: 0,
      max: p.life ?? 1,
      s0: p.size ?? 1,
      s1: p.sizeEnd ?? p.size ?? 1,
      r: p.color[0],
      g: p.color[1],
      b: p.color[2],
      a0: p.alpha ?? 1,
      grav: p.gravity ?? 0,
      drag: p.drag ?? 0,
      floor: p.floor ?? -Infinity,
    })
  }

  update(dt: number): void {
    const list = this.list
    let w = 0
    for (let i = 0; i < list.length; i++) {
      const p = list[i]
      p.life += dt
      if (p.life >= p.max) continue
      const d = Math.exp(-p.drag * dt)
      p.vx *= d
      p.vy = p.vy * d - p.grav * dt
      p.vz *= d
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      if (p.y < p.floor) continue
      list[w++] = p
    }
    list.length = w

    for (let i = 0; i < w; i++) {
      const p = list[i]
      const k = p.life / p.max
      this.pos[i * 3] = p.x
      this.pos[i * 3 + 1] = p.y
      this.pos[i * 3 + 2] = p.z
      this.col[i * 3] = p.r
      this.col[i * 3 + 1] = p.g
      this.col[i * 3 + 2] = p.b
      this.size[i] = p.s0 + (p.s1 - p.s0) * k
      this.alpha[i] = p.a0 * (1 - k * k)
    }

    this.geo.setDrawRange(0, w)
    const attr = this.geo.attributes
    attr.position.needsUpdate = true
    attr.aColor.needsUpdate = true
    attr.aSize.needsUpdate = true
    attr.aAlpha.needsUpdate = true
  }

  clear(): void {
    this.list.length = 0
    this.geo.setDrawRange(0, 0)
  }

  dispose(): void {
    this.clear()
    this.points.removeFromParent()
    this.geo.dispose()
    this.mat.dispose()
    this.texture.dispose()
  }
}

export class PressFX {
  readonly sparksSys: ParticleSystem
  readonly smokeSys: ParticleSystem
  readonly fluidSys: ParticleSystem
  groundAt: (x: number, z: number) => number = () => 0
  private rng: Rng

  constructor(scene: THREE.Scene, isPreview: boolean, seed = 1) {
    this.rng = new Rng(seed)
    const factor = isPreview ? 0.25 : 1
    const sharedTex = createSoftTexture()
    this.sparksSys = new ParticleSystem(scene, { max: Math.round(2500 * factor), additive: true, texture: sharedTex })
    this.smokeSys = new ParticleSystem(scene, { max: Math.round(1500 * factor), texture: sharedTex })
    this.fluidSys = new ParticleSystem(scene, { max: Math.round(3500 * factor), texture: sharedTex })
  }

  setScale(scale: number): void {
    this.sparksSys.setScale(scale)
    this.smokeSys.setScale(scale)
    this.fluidSys.setScale(scale)
  }

  sparks(pos: THREE.Vector3, n = 40, speed = 300, { up = 0.4, spread = 1 }: { up?: number; spread?: number } = {}): void {
    for (let i = 0; i < n; i++) {
      const vx = (this.rng.next() * 2 - 1) * spread
      const vy = (this.rng.next() * 1.2 - 0.2) * up + this.rng.next() * 0.3
      const vz = (this.rng.next() * 2 - 1) * spread
      const dir = new THREE.Vector3(vx, vy, vz).normalize().multiplyScalar(speed * (0.3 + this.rng.next() * 0.9))
      const hot = this.rng.next()
      this.sparksSys.emit({
        pos,
        vel: dir,
        life: 0.25 + this.rng.next() * 0.65,
        size: 0.25 + this.rng.next() * 0.35,
        sizeEnd: 0.05,
        color: [6, 2.4 + hot * 2, 0.5 + hot * 0.6],
        gravity: 700,
        drag: 1.2,
        floor: this.groundAt(pos.x, pos.z),
      })
    }
  }

  smoke(
    pos: THREE.Vector3,
    n = 10,
    {
      color = [0.35, 0.35, 0.36],
      size = 4,
      sizeEnd = 14,
      life = 3,
      rise = 12,
      spread = 3,
      alpha = 0.35,
    }: {
      color?: [number, number, number]
      size?: number
      sizeEnd?: number
      life?: number
      rise?: number
      spread?: number
      alpha?: number
    } = {},
  ): void {
    for (let i = 0; i < n; i++) {
      const p = new THREE.Vector3(
        pos.x + (this.rng.next() * 2 - 1) * spread,
        pos.y + (this.rng.next() * 2 - 1) * spread * 0.4,
        pos.z + (this.rng.next() * 2 - 1) * spread,
      )
      const v = new THREE.Vector3(
        (this.rng.next() * 2 - 1) * 6,
        rise * (0.5 + this.rng.next()),
        (this.rng.next() * 2 - 1) * 6,
      )
      const colVariance = 0.85 + this.rng.next() * 0.3
      this.smokeSys.emit({
        pos: p,
        vel: v,
        life: life * (0.6 + this.rng.next() * 0.7),
        size,
        sizeEnd: sizeEnd * (0.7 + this.rng.next() * 0.6),
        color: [color[0] * colVariance, color[1] * colVariance, color[2] * colVariance],
        alpha,
        drag: 0.6,
      })
    }
  }

  dust(pos: THREE.Vector3, n = 30, color: [number, number, number] = [0.8, 0.8, 0.8], speed = 60): void {
    for (let i = 0; i < n; i++) {
      const a = this.rng.next() * Math.PI * 2
      const spd = speed * (0.3 + this.rng.next() * 0.7)
      const v = new THREE.Vector3(Math.cos(a) * spd, this.rng.next() * speed * 0.4, Math.sin(a) * spd)
      this.smokeSys.emit({
        pos,
        vel: v,
        life: 0.8 + this.rng.next() * 1.2,
        size: 0.8 + this.rng.next() * 1.2,
        sizeEnd: 3 + this.rng.next() * 4,
        color,
        alpha: 0.5,
        drag: 2.5,
      })
    }
  }

  fluid(
    pos: THREE.Vector3,
    dir: THREE.Vector3,
    n = 20,
    speed = 300,
    {
      spread = 0.25,
      size = 0.55,
      life = 1.6,
    }: {
      spread?: number
      size?: number
      life?: number
    } = {},
  ): void {
    const floor = this.groundAt(pos.x, pos.z)
    for (let i = 0; i < n; i++) {
      const offset = new THREE.Vector3(
        (this.rng.next() * 2 - 1) * spread,
        (this.rng.next() * 2 - 1) * spread,
        (this.rng.next() * 2 - 1) * spread,
      )
      const v = dir.clone().normalize().add(offset).normalize().multiplyScalar(speed * (0.6 + this.rng.next() * 0.6))
      const colVar = 0.8 + this.rng.next() * 0.3
      this.fluidSys.emit({
        pos: pos.clone(),
        vel: v,
        life: life * (0.7 + this.rng.next() * 0.5),
        size: size * (0.6 + this.rng.next() * 0.8),
        sizeEnd: size * 0.8,
        color: [0.32 * colVar, 0.16 * colVar, 0.025],
        alpha: 0.95,
        gravity: 981,
        drag: 0.4,
        floor,
      })
    }
  }

  update(dt: number): void {
    this.sparksSys.update(dt)
    this.smokeSys.update(dt)
    this.fluidSys.update(dt)
  }

  clear(): void {
    this.sparksSys.clear()
    this.smokeSys.clear()
    this.fluidSys.clear()
  }

  dispose(): void {
    this.sparksSys.dispose()
    this.smokeSys.dispose()
    this.fluidSys.dispose()
  }
}

interface DebrisItem {
  obj: THREE.Object3D
  v: THREE.Vector3
  w: THREE.Vector3
  bounce: number
  friction: number
  sleep: number
  owned: boolean
}

export class DebrisSystem {
  private readonly scene: THREE.Scene
  private readonly items: DebrisItem[] = []
  private readonly box = new THREE.Box3()
  private readonly q = new THREE.Quaternion()
  private readonly axis = new THREE.Vector3()
  groundAt: (x: number, z: number) => number = () => 0

  constructor(scene: THREE.Scene) {
    this.scene = scene
  }

  add(
    obj: THREE.Object3D,
    vel: THREE.Vector3,
    angVel: THREE.Vector3,
    { bounce = 0.3, friction = 0.6, owned = false }: { bounce?: number; friction?: number; owned?: boolean } = {},
  ): void {
    if (obj.parent !== this.scene) {
      this.scene.attach(obj)
    }
    this.items.push({
      obj,
      v: vel.clone(),
      w: angVel.clone(),
      bounce,
      friction,
      sleep: 0,
      owned,
    })
  }

  update(dt: number): void {
    for (const it of this.items) {
      if (it.sleep > 0.6) continue
      const { obj, v, w } = it
      v.y -= 981 * dt
      obj.position.addScaledVector(v, dt)
      const speed = w.length()
      if (speed > 1e-4) {
        this.q.setFromAxisAngle(this.axis.copy(w).divideScalar(speed), speed * dt)
        obj.quaternion.premultiply(this.q)
      }
      obj.updateMatrixWorld(true)
      this.box.setFromObject(obj)
      const ground = this.groundAt(obj.position.x, obj.position.z)
      if (this.box.min.y < ground) {
        obj.position.y += ground - this.box.min.y
        if (v.y < 0) v.y = -v.y * it.bounce
        v.x *= it.friction
        v.z *= it.friction
        w.multiplyScalar(0.55)
        if (Math.abs(v.y) < 25 && v.lengthSq() < 400) {
          v.set(0, 0, 0)
          w.multiplyScalar(0.2)
        }
      }
      it.sleep = v.lengthSq() < 1 && w.lengthSq() < 0.01 ? it.sleep + dt : 0
    }
  }

  clear(): void {
    for (const it of this.items) {
      it.obj.removeFromParent()
      if (it.owned) {
        it.obj.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose()
          }
        })
      }
    }
    this.items.length = 0
  }

  dispose(): void {
    this.clear()
  }
}
