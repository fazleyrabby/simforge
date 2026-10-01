import { usePageMeta } from '../app/usePageMeta'
import { Footer } from '../components/Footer'
import { Header } from '../components/Header'
import { SimulationGrid } from '../components/SimulationGrid'

export function Home() {
  usePageMeta()
  return (
    <>
      <Header />
      <main className="mx-auto max-w-[1400px] px-3 sm:px-6">
        <section className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 sm:gap-6 py-6 sm:py-10">
          <h1 className="text-2xl font-medium leading-[1.15] tracking-tight text-lab-bright sm:text-5xl">
            Small worlds.
            <br />
            Real systems.
            <br />
            <span className="text-lab-dim">Running in your browser.</span>
          </h1>
          <a href="#simulations" className="lab-btn self-start sm:self-auto">
            Explore simulations ↓
          </a>
        </section>
        <section id="simulations" aria-label="Simulations" className="scroll-mt-4">
          <SimulationGrid />
        </section>
      </main>
      <Footer />
    </>
  )
}
