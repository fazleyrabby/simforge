import type { ParamValue, Simulation } from './Simulation'

export interface ParamDefinition {
  key: string
  label: string
  type: 'range' | 'toggle' | 'select'
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: { value: string; label: string }[]
  default: ParamValue
  /** Overrides the default when the simulation runs as a homepage preview. */
  previewDefault?: ParamValue
}

export interface StatDefinition {
  key: string
  label: string
  unit?: string
}

export interface ActionDefinition {
  key: string
  label: string
}

export interface SimulationDefinition {
  id: string
  index: string
  title: string
  description: string
  /** Longer text description, also shown when WebGL is unavailable. */
  summary: string
  category: string
  camera: 'orthographic' | 'perspective'
  params: ParamDefinition[]
  stats: StatDefinition[]
  /** Stat keys shown in the homepage hover overlay. */
  previewStats: string[]
  actions: ActionDefinition[]
  /** Label for the button that re-rolls the seed. */
  randomizeLabel: string
  /** Seed used by the homepage preview; the card links to the same seed. */
  previewSeed: number
  /** Grid placement classes for the homepage bento layout. */
  layout: string
  /** Extra hint line shown under the controls. */
  hint?: string
  load: () => Promise<{ default: new () => Simulation }>
}

export function defaultParams(
  definition: SimulationDefinition,
  preview = false,
): Record<string, ParamValue> {
  const values: Record<string, ParamValue> = {}
  for (const param of definition.params) {
    values[param.key] = preview && param.previewDefault !== undefined ? param.previewDefault : param.default
  }
  return values
}
