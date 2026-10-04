import type { SimulationDefinition } from '../simulations/core/registry'
import { simulationMeta } from './simulationMeta'

/** Each simulation's code ships as its own lazily loaded chunk. */
const loaders: Record<string, SimulationDefinition['load']> = {
  gears: () => import('../simulations/gears/GearSimulation'),
  heat: () => import('../simulations/heat/HeatSimulation'),
  dyno: () => import('../simulations/dyno/DynoSimulation'),
  factory: () => import('../simulations/factory/FactorySimulation'),
  rack: () => import('../simulations/rack/RackSimulation'),
  orbital: () => import('../simulations/orbital/OrbitalSimulation'),
  press: () => import('../simulations/press/PressSimulation'),
  warehouse: () => import('../simulations/warehouse/WarehouseSimulation'),
  tunnel: () => import('../simulations/tunnel/TunnelSimulation'),
  seismic: () => import('../simulations/seismic/SeismicSimulation'),
  maglev: () => import('../simulations/maglev/MaglevSimulation'),
}

/**
 * The simulation registry: metadata plus a loader. The homepage grid, routes,
 * control panels and statistics are all generated from this list.
 */
export const simulations: SimulationDefinition[] = simulationMeta.map((meta) => ({
  ...meta,
  load: loaders[meta.id],
}))

export function findSimulation(id: string | undefined): SimulationDefinition | undefined {
  return simulations.find((simulation) => simulation.id === id)
}
