import * as THREE from 'three'
import { makeIsoCamera } from '../../three/cameras'
import { gearColors, palette } from '../../three/palette'
import { makePlinth } from '../../three/plinth'
import { BaseSimulation } from '../core/BaseSimulation'
import { STEP, type ParamValue, type StatValue } from '../core/Simulation'
import { createGearGeometry } from './gearGeometry'
import { gearAngle, generateGearTrain, systemEfficiency, type GearTrain } from './GearGenerator'

const THICKNESS = 0.34
const GEAR_Y = 0.42

export default class GearSimulation extends BaseSimulation {
  private train: GearTrain = { gears: [], module: 0.16, bound: 1, maxDepth: 0 }
  private meshes: THREE.Mesh[] = []
  private driverAngle = 0
  private driverGlow: THREE.MeshStandardMaterial | null = null

  constructor() {
    super(makeIsoCamera(new THREE.Vector3(1, 1.15, 1)))
    this.params = { speed: 24, torque: 20, gearCount: 9, gearSize: 1 }
  }

  protected build(): void {
    this.driverAngle = 0
    this.meshes = []
    this.train = generateGearTrain(this.rng, this.num('gearCount'), this.num('gearSize'))
    const { gears, module, bound } = this.train

    // Center the board on the train rather than on the driver.
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const gear of gears) {
      const reach = gear.radius + module
      minX = Math.min(minX, gear.x - reach)
      maxX = Math.max(maxX, gear.x + reach)
      minZ = Math.min(minZ, gear.z - reach)
      maxZ = Math.max(maxZ, gear.z + reach)
    }
    const centerX = (minX + maxX) / 2
    const centerZ = (minZ + maxZ) / 2
    const spanX = maxX - minX
    const spanZ = maxZ - minZ

    const content = new THREE.Group()
    content.position.set(-centerX, 0, -centerZ)
    this.world.add(content)

    const plinth = makePlinth(spanX + 2.4, spanZ + 2.4)
    this.world.add(plinth)

    const geometries = new Map<number, THREE.BufferGeometry>()
    const materials = new Map<number, THREE.MeshStandardMaterial>()
    for (const gear of gears) {
      let geometry = geometries.get(gear.teeth)
      if (!geometry) {
        geometry = createGearGeometry(gear.teeth, module, THICKNESS)
        geometries.set(gear.teeth, geometry)
      }
      const colorIndex = gear.depth === 0 ? 0 : 1 + ((gear.depth - 1) % (gearColors.length - 1))
      let material = materials.get(colorIndex)
      if (!material) {
        material = new THREE.MeshStandardMaterial({
          color: gearColors[colorIndex],
          metalness: 0.55,
          roughness: 0.42,
        })
        if (colorIndex === 0) {
          material.emissive = new THREE.Color(palette.amber)
          material.emissiveIntensity = 0.12
          this.driverGlow = material
        }
        materials.set(colorIndex, material)
      }
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(gear.x, GEAR_Y, gear.z)
      content.add(mesh)
      this.meshes.push(mesh)
    }

    // Axles and base washers repeat for every gear, so they are instanced.
    const boreRadius = Math.max(module * 1.1, 0.1)
    const axleMaterial = new THREE.MeshStandardMaterial({ color: palette.steelDark, metalness: 0.7, roughness: 0.35 })
    const axles = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(boreRadius * 0.92, boreRadius * 0.92, GEAR_Y + THICKNESS + 0.14, 12),
      axleMaterial,
      gears.length,
    )
    const washers = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 1.08, GEAR_Y - 0.04, 20),
      new THREE.MeshStandardMaterial({ color: 0x20262d, metalness: 0.3, roughness: 0.7 }),
      gears.length,
    )
    const matrix = new THREE.Matrix4()
    const scale = new THREE.Vector3()
    const rotation = new THREE.Quaternion()
    const position = new THREE.Vector3()
    gears.forEach((gear, index) => {
      matrix.makeTranslation(gear.x, (GEAR_Y + THICKNESS + 0.14) / 2, gear.z)
      axles.setMatrixAt(index, matrix)
      const washerRadius = Math.max(gear.radius * 0.45, boreRadius * 1.8)
      position.set(gear.x, (GEAR_Y - 0.04) / 2, gear.z)
      scale.set(washerRadius, 1, washerRadius)
      matrix.compose(position, rotation, scale)
      washers.setMatrixAt(index, matrix)
    })
    content.add(axles, washers)

    // Motor housing under the driver marks where power enters the train.
    const driver = gears[0]
    const motor = new THREE.Mesh(
      new THREE.CylinderGeometry(driver.radius * 0.62, driver.radius * 0.7, 0.2, 6),
      new THREE.MeshStandardMaterial({ color: palette.amber, metalness: 0.4, roughness: 0.5 }),
    )
    motor.position.set(driver.x, GEAR_Y + THICKNESS + 0.12, driver.z)
    content.add(motor)
    this.meshes.push(motor)

    this.enableShadows(this.world)
    this.lighting.setShadowExtent(bound + 4)
    const span = Math.max(spanX, spanZ) + 2.4
    this.setView(span * 0.74, span * 0.5 + (this.isPreview ? 0.4 : 1.2))
  }

  protected update(dt: number): void {
    this.driverAngle += this.driverOmega() * dt
  }

  render(alpha: number): void {
    const angle = this.driverAngle + this.driverOmega() * STEP * alpha
    const gears = this.train.gears
    for (let i = 0; i < gears.length; i++) {
      this.meshes[i].rotation.y = gearAngle(gears[i], angle)
    }
    // The motor cap is the last mesh and turns with the driver.
    this.meshes[gears.length].rotation.y = angle
    if (this.driverGlow) {
      this.driverGlow.emissiveIntensity = 0.1 + Math.min(this.num('torque') / 100, 1) * 0.25
    }
  }

  protected onParam(key: string, _value: ParamValue): void {
    if (key === 'gearCount' || key === 'gearSize') this.rebuild()
  }

  getStats(): Record<string, StatValue> {
    const rpm = this.num('speed')
    const torque = this.num('torque')
    const efficiency = systemEfficiency(this.train)
    return {
      rpm: rpm.toFixed(0),
      torque: torque.toFixed(0),
      power: (torque * Math.abs(this.driverOmega())).toFixed(1),
      gearCount: this.train.gears.length,
      efficiency: (efficiency * 100).toFixed(1),
    }
  }

  entityCount(): number {
    return this.train.gears.length
  }

  /** Driver angular velocity in rad/s from the Speed control (RPM). */
  private driverOmega(): number {
    return (this.num('speed') * Math.PI * 2) / 60
  }
}
