import { usePageMeta } from '../app/usePageMeta'
import { Footer } from '../components/Footer'
import { Header } from '../components/Header'
import { SimulationGrid } from '../components/SimulationGrid'

export function SimulationsIndex() {
  usePageMeta('Simulations')
  return (
    <>
      <Header />
      <main className="mx-auto max-w-[1400px] px-4 sm:px-6">
        <h1 className="lab-label py-6 !text-lab-text">All simulations</h1>
        <SimulationGrid />
      </main>
      <Footer />
    </>
  )
}
