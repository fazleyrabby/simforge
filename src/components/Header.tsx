import { Link, NavLink } from 'react-router-dom'
import { site } from '../data/site'
import { SoundToggle } from './SoundToggle'
import { SupportButton } from './SupportButton'

const navClass = ({ isActive }: { isActive: boolean }) =>
  `lab-label transition-colors hover:text-lab-bright ${isActive ? '!text-amber' : ''}`

export function Header() {
  return (
    <header className="border-b border-lab-line">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-3 sm:px-6 sm:py-4">
        <Link to="/" className="flex items-baseline gap-2 sm:gap-3">
          <span className="font-mono text-xs font-semibold tracking-[0.18em] text-lab-bright sm:text-sm sm:tracking-[0.22em]">SIMULATION LAB</span>
          <span className="hidden text-xs text-lab-dim md:inline">{site.tagline}</span>
        </Link>
        <nav aria-label="Primary" className="flex items-center gap-3.5 sm:gap-6">
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
          <SupportButton />
          <SoundToggle />
        </nav>
      </div>
    </header>
  )
}
