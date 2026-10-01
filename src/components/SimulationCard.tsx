import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSimulation } from '../app/useSimulation'
import { defaultParams, type SimulationDefinition } from '../simulations/core/registry'
import type { StatValue } from '../simulations/core/Simulation'
import { SimulationStatus } from './SimulationStatus'
import { audioEngine } from '../audio/AudioEngine'

const ACTIVE_TIME_SCALE = 1.6

/** A homepage card: a live, reduced-complexity instance of the real simulation. */
export function SimulationCard({ definition }: { definition: SimulationDefinition }) {
  const [card, setCard] = useState<HTMLElement | null>(null)
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [hovered, setHovered] = useState(false)
  const [centered, setCentered] = useState(false)
  const [stats, setStats] = useState<Record<string, StatValue>>({})
  const params = useMemo(() => defaultParams(definition, true), [definition])
  const { status, simulation, slot, reload } = useSimulation(
    definition,
    element,
    'preview',
    definition.previewSeed,
    params,
  )
  const active = hovered || centered

  // Off-screen cards neither simulate nor render.
  useEffect(() => {
    if (!element || !slot) return
    const observer = new IntersectionObserver(([entry]) => {
      slot.visible = entry.isIntersecting
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, slot])

  // Touch devices cannot hover: the card nearest the middle of the screen is the active one.
  useEffect(() => {
    if (!card || !window.matchMedia('(hover: none)').matches) return
    const observer = new IntersectionObserver(([entry]) => setCentered(entry.isIntersecting), {
      rootMargin: '-45% 0px -45% 0px',
    })
    observer.observe(card)
    return () => observer.disconnect()
  }, [card])

  useEffect(() => {
    if (slot) slot.timeScale = active ? ACTIVE_TIME_SCALE : 1
  }, [slot, active])

  useEffect(() => {
    if (!simulation || !active) return
    const read = () => setStats(simulation.getStats())
    read()
    const timer = window.setInterval(read, 400)
    return () => window.clearInterval(timer)
  }, [simulation, active])

  const previewStats = definition.stats.filter((stat) => definition.previewStats.includes(stat.key))

  return (
    <Link
      ref={setCard}
      to={`/simulations/${definition.id}?seed=${definition.previewSeed}`}
      viewTransition
      aria-label={`Open simulation: ${definition.title}. ${definition.description}`}
      className={`lab-ticks group relative block border transition-[transform,border-color] duration-200 ease-out ${
        active ? 'z-10 scale-[1.012] border-amber/70 [--tick:var(--color-amber)]' : 'border-lab-line'
      } ${definition.layout}`}
      style={{ viewTransitionName: `sim-${definition.id}` }}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') {
          audioEngine.playCardHover()
          setHovered(true)
        }
      }}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => {
        audioEngine.playCardHover()
        setHovered(true)
      }}
      onBlur={() => setHovered(false)}
      onClick={() => audioEngine.playUiClick('neutral')}
    >
      <div ref={setElement} className="absolute inset-0" />

      <div className="pointer-events-none absolute left-0 top-0 flex max-w-full items-start gap-3 p-3 sm:p-4">
        <span className="font-mono text-xs text-amber">{definition.index}</span>
        <div>
          <h3 className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-lab-bright">
            {definition.title}
          </h3>
          <p className="mt-1 text-xs text-lab-dim">{definition.description}</p>
        </div>
      </div>
      <span className="lab-label pointer-events-none absolute right-3 top-3 hidden sm:right-4 sm:top-4 sm:block">
        {definition.category}
      </span>

      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-2 p-2.5 transition-opacity duration-200 sm:gap-3 sm:p-4 ${
          active && status === 'ready' ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <dl className="lab-panel flex flex-wrap gap-2.5 sm:gap-5 px-2.5 py-1.5 sm:px-3 sm:py-2">
          {previewStats.map((stat) => (
            <div key={stat.key}>
              <dt className="lab-label !text-[0.5625rem] sm:!text-[0.625rem]">{stat.label}</dt>
              <dd className="font-mono text-xs tabular-nums text-lab-bright sm:text-sm">
                {stats[stat.key] ?? '—'}
                {stat.unit && <span className="ml-0.5 sm:ml-1 text-[0.625rem] sm:text-xs text-lab-dim">{stat.unit}</span>}
              </dd>
            </div>
          ))}
        </dl>
        <span className="lab-panel px-2.5 py-1.5 sm:px-3 sm:py-2 font-mono text-[0.625rem] sm:text-[0.6875rem] font-medium tracking-[0.14em] text-amber">
          OPEN SIMULATION →
        </span>
      </div>

      <SimulationStatus status={status} onReload={reload} />
    </Link>
  )
}
