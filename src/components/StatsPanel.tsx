import { useSyncExternalStore } from 'react'
import type { StatsStore } from '../app/statsStore'
import type { SimulationDefinition } from '../simulations/core/registry'

interface Props {
  definition: SimulationDefinition
  store: StatsStore
}

/** Live statistics, generated from the registry's stat schema. */
export function StatsPanel({ definition, store }: Props) {
  const stats = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const rows = definition.stats.filter((stat) => stats[stat.key] !== undefined)

  return (
    <section aria-label={`${definition.title} statistics`} className="lab-panel min-w-40 px-3 py-2.5 sm:min-w-52 sm:px-4 sm:py-3">
      <dl className="flex flex-col gap-1.5">
        {rows.map((stat) => (
          <div key={stat.key} className="flex items-baseline justify-between gap-4">
            <dt className="lab-label !text-[0.625rem]">{stat.label}</dt>
            <dd className="whitespace-pre font-mono text-xs tabular-nums text-lab-bright sm:text-sm">
              {stats[stat.key]}
              {stat.unit && <span className="ml-1 text-[0.6875rem] text-lab-dim">{stat.unit}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
