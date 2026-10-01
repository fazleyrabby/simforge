import { useVisits } from '../app/visitorCounter'
import { simulations } from '../data/simulations'

export function Footer() {
  const visits = useVisits()
  return (
    <footer className="mt-16 border-t border-lab-line">
      <div className="lab-label mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-5 sm:px-6">
        <span>Simulation Lab</span>
        <span>{simulations.length} worlds · one WebGL context · fixed 60 Hz timestep</span>
        <span className="flex items-center gap-2" title="Total visits">
          <span aria-hidden="true" className="h-1.5 w-1.5 bg-amber" />
          Visits
          <span aria-live="polite" className="tabular-nums text-lab-bright">
            {visits.toLocaleString()}
          </span>
        </span>
      </div>
    </footer>
  )
}
