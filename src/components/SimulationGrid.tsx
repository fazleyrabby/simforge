import { simulations } from '../data/simulations'
import { SimulationCard } from './SimulationCard'

/** Bento grid generated from the registry. Adding a simulation there adds a card here. */
export function SimulationGrid() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2 lg:grid-cols-6">
      {simulations.map((definition) => (
        <SimulationCard key={definition.id} definition={definition} />
      ))}
    </div>
  )
}
