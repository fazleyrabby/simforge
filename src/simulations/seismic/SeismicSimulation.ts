import * as THREE from 'three'
import { makeIsoCamera } from '../../three/cameras'
import { palette } from '../../three/palette'
import { makePlinth } from '../../three/plinth'
import { BaseSimulation } from '../core/BaseSimulation'
import type { ParamValue, StatValue } from '../core/Simulation'
import { ShakeTableModel, type ShakeParams } from './ShakeTableModel'
import { SeismicScope } from './SeismicScope'

const LEVEL = 1.75
const WIDTH = 3.8
const DEPTH = 2.6

export default class SeismicSimulation extends BaseSimulation {
  private model!: ShakeTableModel
  private table!: THREE.Group
  private decks: THREE.Group[] = []
  private columns: THREE.Mesh[][] = []
  private damper!: THREE.Group
  private damperHousing!: THREE.Group
  private scope!: SeismicScope
  private scopeTick = 0
  private braces: THREE.Mesh[][] = []
  private springs: THREE.Line[] = []
  private dashpots: THREE.Mesh[][] = []
  private sensorLights: THREE.MeshStandardMaterial[] = []
  private actuatorRod!: THREE.Mesh

  constructor() {
    super(makeIsoCamera(new THREE.Vector3(0.9, 0.65, 1.3)))
    this.params = { frequency: 1, amplitude: 0.05, damping: 6, damper: false, tuning: 1 }
  }

  protected build(): void {
    this.model = new ShakeTableModel(this.readParams())
    this.decks = []
    this.columns = []
    this.braces = []
    this.springs = []
    this.dashpots = []
    this.sensorLights = []
    this.scopeTick = 0
    this.world.position.y = -2.7

    const steel = new THREE.MeshStandardMaterial({ color: palette.steel, metalness: 0.72, roughness: 0.31 })
    const dark = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.63, roughness: 0.4 })
    const cyan = new THREE.MeshStandardMaterial({ color: palette.cyan, metalness: 0.3, roughness: 0.3, emissive: palette.cyan, emissiveIntensity: 0.27 })
    const amber = new THREE.MeshStandardMaterial({ color: palette.amber, metalness: 0.32, roughness: 0.35, emissive: palette.amber, emissiveIntensity: 0.24 })
    const rubber = new THREE.MeshStandardMaterial({ color: palette.rubber, roughness: 0.86 })

    const base = makePlinth(10.5, 6.8)
    this.world.add(base)
    this.buildBenchDetails(steel, dark, amber, rubber)
    // Two fixed tracks make the platform motion readable from the homepage.
    for (const z of [-1.15, 1.15]) {
      this.box(this.world, 7.5, 0.12, 0.19, dark, 0, 0.12, z)
      for (const x of [-3.25, 3.25]) {
        const stop = this.box(this.world, 0.16, 0.35, 0.34, amber, x, 0.28, z)
        stop.castShadow = false
      }
    }
    this.table = new THREE.Group()
    this.world.add(this.table)
    this.box(this.table, 5.5, 0.3, 3.7, steel, 0, 0.42, 0)
    this.box(this.table, 5.4, 0.055, 3.55, dark, 0, 0.6, 0)
    for (let n = 0; n < 16; n++) {
      const x = -2.4 + n * 0.32
      this.box(this.table, 0.16, 0.085, 0.035, n % 2 ? amber : rubber, x, 0.43, 1.865)
    }
    for (const z of [-1.25, 1.25]) {
      for (const x of [-1.85, 1.85]) {
        this.box(this.table, 0.75, 0.2, 0.75, amber, x, 0.67, z)
        for (const dx of [-0.25, 0.25]) {
          for (const dz of [-0.25, 0.25]) {
            this.bolt(this.table, x + dx, 0.8, z + dz, steel)
          }
        }
      }
    }

    const actuator = this.box(this.world, 1.12, 0.5, 0.74, dark, -3.66, 0.47, 0)
    actuator.castShadow = true
    this.box(this.world, 0.18, 0.58, 0.84, amber, -3.18, 0.47, 0)
    this.actuatorRod = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 1, 12), steel)
    this.actuatorRod.rotation.z = Math.PI / 2
    this.actuatorRod.position.set(-2.95, 0.47, 0)
    this.world.add(this.actuatorRod)
    for (const z of [-0.25, 0.25]) {
      const hose = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
          new THREE.Vector3(-4.2, 0.5, z),
          new THREE.Vector3(-4.65, 0.25, z * 1.7),
          new THREE.Vector3(-4.35, 0.08, z * 2.4),
        ]), 20, 0.035, 6, false),
        rubber,
      )
      this.world.add(hose)
    }

    for (let i = 0; i < 3; i++) {
      const deck = new THREE.Group()
      this.world.add(deck)
      this.decks.push(deck)
      const y = 0.9 + (i + 1) * LEVEL
      this.box(deck, WIDTH, 0.22, DEPTH, steel, 0, y, 0)
      this.box(deck, WIDTH - 0.16, 0.045, DEPTH - 0.14, dark, 0, y + 0.14, 0)
      for (const z of [-DEPTH / 2 + 0.1, DEPTH / 2 - 0.1]) {
        this.box(deck, WIDTH, 0.05, 0.08, i === 2 ? amber : cyan, 0, y + 0.18, z)
      }
      // A visible lumped floor mass and open bracing make the model a test rig.
      this.box(deck, 0.6, 0.36, 0.65, dark, 0, y + 0.31, 0)
      this.box(deck, 0.36, 0.07, 0.7, i === 2 ? amber : cyan, 0, y + 0.54, 0)
      for (const x of [-WIDTH / 2 + 0.18, WIDTH / 2 - 0.18]) {
        for (const z of [-DEPTH / 2 + 0.18, DEPTH / 2 - 0.18]) {
          this.bolt(deck, x, y + 0.15, z, dark)
        }
      }
      const sensor = this.box(deck, 0.34, 0.2, 0.2, dark, WIDTH / 2 - 0.48, y + 0.25, DEPTH / 2 + 0.02)
      sensor.castShadow = false
      const light = new THREE.MeshStandardMaterial({ color: palette.green, emissive: palette.green, emissiveIntensity: 1.2 })
      this.box(deck, 0.13, 0.065, 0.055, light, WIDTH / 2 - 0.48, y + 0.27, DEPTH / 2 + 0.15)
      this.sensorLights.push(light)

      const storeyColumns: THREE.Mesh[] = []
      for (const x of [-WIDTH / 2 + 0.17, WIDTH / 2 - 0.17]) {
        for (const z of [-DEPTH / 2 + 0.17, DEPTH / 2 - 0.17]) {
          const column = this.box(this.world, 0.1, LEVEL, 0.1, steel, x, y - LEVEL / 2, z)
          storeyColumns.push(column)
        }
      }
      this.columns.push(storeyColumns)
      const rearBraces: THREE.Mesh[] = []
      for (let b = 0; b < 2; b++) {
        const brace = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1, 0.07), dark)
        brace.position.z = -DEPTH / 2 + 0.04
        this.world.add(brace)
        rearBraces.push(brace)
      }
      this.braces.push(rearBraces)
      const spring = this.makeSpring()
      this.world.add(spring)
      this.springs.push(spring)
      const damperBody = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1, 10), dark)
      const damperStem = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 1, 8), steel)
      damperBody.position.z = DEPTH / 2 + 0.15
      damperStem.position.z = DEPTH / 2 + 0.15
      this.world.add(damperBody, damperStem)
      this.dashpots.push([damperBody, damperStem])
    }

    const roofY = 0.9 + 3 * LEVEL
    this.damperHousing = new THREE.Group()
    this.world.add(this.damperHousing)
    this.box(this.damperHousing, 2.25, 0.11, 1.08, dark, 0, roofY + 0.53, 0)
    for (const x of [-1.05, 1.05]) this.box(this.damperHousing, 0.08, 0.72, 1.08, steel, x, roofY + 0.9, 0)
    this.damper = new THREE.Group()
    this.world.add(this.damper)
    this.box(this.damper, 0.86, 0.54, 0.82, amber, 0, roofY + 0.91, 0)
    this.box(this.damper, 0.96, 0.055, 0.92, dark, 0, roofY + 1.21, 0)

    this.scope = new SeismicScope(this.isPreview)
    this.world.add(this.scope.group)

    this.enableShadows(this.world)
    this.lighting.setShadowExtent(12)
    this.focus.set(0, 0.55, 0)
    this.setView(5.8, this.isPreview ? 5.4 : 5.1)
    this.render(0)
  }

  protected update(dt: number): void {
    this.model.step(dt)
    if (++this.scopeTick % (this.isPreview ? 6 : 3) === 0) {
      this.scope.sample(this.model.baseX, this.model.roofX, this.model.frequencyRatio, this.model.peakRoof * 100)
    }
  }

  render(_alpha: number): void {
    if (!this.model || !this.table) return
    const baseX = this.model.baseX
    this.table.position.x = baseX
    for (let i = 0; i < 3; i++) {
      const currentX = baseX + this.model.floors[i]
      const belowX = i === 0 ? baseX : baseX + this.model.floors[i - 1]
      this.decks[i].position.x = currentX
      const delta = currentX - belowX
      const length = Math.hypot(LEVEL, delta)
      for (let j = 0; j < 4; j++) {
        const column = this.columns[i][j]
        const localX = j < 2 ? -WIDTH / 2 + 0.17 : WIDTH / 2 - 0.17
        column.position.x = (currentX + belowX) / 2 + localX
        column.rotation.z = -Math.atan2(delta, LEVEL)
        column.scale.y = length / LEVEL
      }
      const lowY = 0.9 + i * LEVEL
      const highY = lowY + LEVEL
      const backZ = -DEPTH / 2 + 0.04
      this.setBeam(this.braces[i][0], belowX - WIDTH / 2 + 0.17, lowY, currentX + WIDTH / 2 - 0.17, highY, backZ)
      this.setBeam(this.braces[i][1], belowX + WIDTH / 2 - 0.17, lowY, currentX - WIDTH / 2 + 0.17, highY, backZ)
      const spring = this.springs[i]
      spring.position.set((currentX + belowX) / 2 - 0.65, (lowY + highY) / 2, DEPTH / 2 + 0.15)
      spring.rotation.z = -Math.atan2(delta, LEVEL)
      spring.scale.y = length / LEVEL
      this.setBeam(this.dashpots[i][0], belowX + 0.65, lowY + 0.15, belowX + delta * 0.46 + 0.65, lowY + LEVEL * 0.46, DEPTH / 2 + 0.15)
      this.setBeam(this.dashpots[i][1], belowX + delta * 0.45 + 0.65, lowY + LEVEL * 0.45, currentX + 0.65, highY - 0.15, DEPTH / 2 + 0.15)
      const drift = Math.abs(delta)
      const color = drift > 0.25 ? palette.red : drift > 0.1 ? palette.amber : palette.green
      this.sensorLights[i].color.setHex(color)
      this.sensorLights[i].emissive.setHex(color)
    }
    const roofX = baseX + this.model.floors[2]
    this.damperHousing.position.x = roofX
    this.damper.position.x = this.bool('damper') ? baseX + this.model.damperX : roofX
    this.damperHousing.visible = this.bool('damper')
    this.damper.visible = this.bool('damper')
    const rodEnd = -2.72 + baseX
    const rodStart = -3.15
    this.actuatorRod.position.x = (rodStart + rodEnd) / 2
    this.actuatorRod.scale.y = Math.max(0.1, rodEnd - rodStart)
  }

  protected onParam(_key: string, _value: ParamValue): void {
    this.model.params = this.readParams()
    this.model.reset()
    this.scope.reset()
    this.scopeTick = 0
  }

  getStats(): Record<string, StatValue> {
    return {
      roof: (this.model.roofX * 100).toFixed(1),
      peak: (this.model.peakRoof * 100).toFixed(1),
      acceleration: (this.model.peakAcceleration / 9.81).toFixed(2),
      drift: (this.model.peakStoryDrift * 100).toFixed(1),
      natural: this.model.naturalFrequency.toFixed(2),
      ratio: this.model.frequencyRatio.toFixed(2),
      tuning: this.bool('damper') ? 'ENGAGED' : 'OFF',
      travel: (Math.abs(this.model.damperTravel) * 100).toFixed(1),
      elapsed: `${this.model.time.toFixed(1)} s`,
    }
  }

  entityCount(): number { return 3 + (this.bool('damper') ? 1 : 0) }

  private buildBenchDetails(steel: THREE.Material, dark: THREE.Material, amber: THREE.Material, rubber: THREE.Material): void {
    for (let n = -6; n <= 6; n++) {
      const x = n * 0.5
      this.box(this.world, 0.018, 0.015, n % 2 === 0 ? 0.3 : 0.18, n === 0 ? amber : steel, x, 0.012, 2.65)
    }
    this.box(this.world, 6.7, 0.045, 0.08, dark, 0, 0.012, 2.88)
    for (const x of [-3.3, 3.3]) {
      for (const z of [-1.15, 1.15]) {
        this.bolt(this.world, x, 0.2, z, rubber)
      }
    }
  }

  private bolt(parent: THREE.Object3D, x: number, y: number, z: number, material: THREE.Material): void {
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.035, 6), material)
    bolt.position.set(x, y, z)
    parent.add(bolt)
  }

  private makeSpring(): THREE.Line {
    const points: THREE.Vector3[] = []
    for (let n = 0; n <= 120; n++) {
      const t = n / 120
      const angle = t * Math.PI * 20
      points.push(new THREE.Vector3(Math.cos(angle) * 0.13, (t - 0.5) * LEVEL * 0.8, Math.sin(angle) * 0.13))
    }
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: palette.cyan }))
  }

  private setBeam(mesh: THREE.Mesh, ax: number, ay: number, bx: number, by: number, z: number): void {
    mesh.position.set((ax + bx) / 2, (ay + by) / 2, z)
    mesh.rotation.z = -Math.atan2(bx - ax, by - ay)
    mesh.scale.y = Math.hypot(bx - ax, by - ay)
  }

  private readParams(): ShakeParams {
    return {
      frequency: this.num('frequency'),
      amplitude: this.num('amplitude'),
      damping: this.num('damping'),
      damper: this.bool('damper'),
      tuning: this.num('tuning'),
    }
  }

  private box(parent: THREE.Object3D, w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material)
    mesh.position.set(x, y, z)
    mesh.castShadow = true
    mesh.receiveShadow = true
    parent.add(mesh)
    return mesh
  }
}
