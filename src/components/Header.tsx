import { Link, NavLink } from 'react-router-dom'
import { site } from '../data/site'

const navClass = ({ isActive }: { isActive: boolean }) =>
  `lab-label transition-colors hover:text-lab-bright ${isActive ? '!text-amber' : ''}`

export function Header() {
  return (
    <header className="border-b border-lab-line">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-x-8 gap-y-2 px-4 py-4 sm:px-6">
        <Link to="/" className="flex items-baseline gap-3">
          <span className="font-mono text-sm font-semibold tracking-[0.22em] text-lab-bright">SIMULATION LAB</span>
          <span className="hidden text-xs text-lab-dim md:inline">{site.tagline}</span>
        </Link>
        <nav aria-label="Primary" className="flex items-center gap-6">
          <NavLink to="/simulations" className={navClass}>
            Simulations
          </NavLink>
          <NavLink to="/about" className={navClass}>
            About
          </NavLink>
          {site.githubUrl && (
            <a href={site.githubUrl} target="_blank" rel="noreferrer" className="lab-label hover:text-lab-bright">
              GitHub
            </a>
          )}
        </nav>
      </div>
    </header>
  )
}
