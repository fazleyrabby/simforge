import { usePageMeta } from '../app/usePageMeta'
import { Footer } from '../components/Footer'
import { Header } from '../components/Header'
import { SimulationGrid } from '../components/SimulationGrid'

export function Home() {
  usePageMeta()
  return (
    <>
      <Header />
      <main className="mx-auto max-w-[1400px] px-4 sm:px-6">
        <section className="flex flex-wrap items-end justify-between gap-6 py-8 sm:py-10">
          <h1 className="text-3xl font-medium leading-[1.1] tracking-tight text-lab-bright sm:text-5xl">
            Small worlds.
            <br />
            Real systems.
            <br />
            <span className="text-lab-dim">Running in your browser.</span>
          </h1>
          <a href="#simulations" className="lab-btn">
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
