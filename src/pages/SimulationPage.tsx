import { useParams } from 'react-router-dom'
import { SimulationViewer } from '../components/SimulationViewer'
import { findSimulation } from '../data/simulations'
import { NotFound } from './NotFound'

export function SimulationPage() {
  const { id } = useParams()
  const definition = findSimulation(id)
  if (!definition) return <NotFound />
  // Keyed so switching simulations starts from clean viewer state.
  return <SimulationViewer key={definition.id} definition={definition} />
}
