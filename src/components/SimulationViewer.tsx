import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { StatsStore } from '../app/statsStore'
import { usePageMeta } from '../app/usePageMeta'
import { useSimulation } from '../app/useSimulation'
import { randomSeed } from '../simulations/core/random'
import { defaultParams, type SimulationDefinition } from '../simulations/core/registry'
import type { ParamValue } from '../simulations/core/Simulation'
import { isMobile, prefersReducedMotion } from '../three/Stage'
import { ControlPanel } from './ControlPanel'
import { DebugPanel } from './DebugPanel'
import { SimulationStatus } from './SimulationStatus'
import { StatsPanel } from './StatsPanel'

interface Alert {
  id: number
  level: 'info' | 'warn'
  title: string
  message?: string
}

function parseSeed(value: string | null): number | null {
  if (value === null || !/^\d{1,9}$/.test(value)) return null
  return Number(value)
}

/** Shortcuts must not hijack keys meant for a focused control. */
function isInteractive(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('input, textarea, select, button, a, [role="switch"]') !== null
}

/** The shared full-screen experience every simulation runs inside. */
export function SimulationViewer({ definition }: { definition: SimulationDefinition }) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [seed, setSeed] = useState(() => parseSeed(searchParams.get('seed')) ?? randomSeed())
  const [values, setValues] = useState(() => defaultParams(definition))
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [paused, setPaused] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(() => !isMobile())
  const [statsOpen, setStatsOpen] = useState(() => !isMobile())
  const [debug, setDebug] = useState(() => searchParams.get('debug') === 'true')
  const [copied, setCopied] = useState(false)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const store = useMemo(() => new StatsStore(), [])
  const controlsRef = useRef<OrbitControls | null>(null)
  const alertId = useRef(0)

  const { status, simulation, slot, reload } = useSimulation(definition, element, 'full', seed, values)
  usePageMeta(definition.title, definition.summary, `/og/${definition.id}.png`)

  // The seed always lives in the URL so the address bar is shareable as-is.
  useEffect(() => {
    if (searchParams.get('seed') === String(seed)) return
    const next = new URLSearchParams(searchParams)
    next.set('seed', String(seed))
    setSearchParams(next, { replace: true })
  }, [seed, searchParams, setSearchParams])

  useEffect(() => {
    if (slot) slot.paused = paused
  }, [slot, paused])

  // Camera controls: orbit, pan, zoom. The simulation can take the camera over (e.g. follow cam).
  useEffect(() => {
    if (!simulation || !slot || !element) return
    const controls = new OrbitControls(simulation.camera, element)
    controls.target.copy(simulation.focus)
    controls.enableDamping = !prefersReducedMotion()
    controls.dampingFactor = 0.09
    controls.maxPolarAngle = Math.PI * 0.47
    controls.minZoom = 0.5
    controls.maxZoom = 6
    controls.minDistance = 6
    controls.maxDistance = 110
    controls.update()
    controls.saveState()
    controlsRef.current = controls
    slot.onFrame = () => {
      controls.enabled = simulation.hostCameraEnabled
      if (controls.enabled) controls.update()
    }
    return () => {
      slot.onFrame = null
      controlsRef.current = null
      controls.dispose()
    }
  }, [simulation, slot, element])

  // Statistics are polled at 5 Hz; discrete events are pushed.
  useEffect(() => {
    if (!simulation) return
    const read = () => store.set(simulation.getStats())
    read()
    const timer = window.setInterval(read, 200)
    const unsubscribe = simulation.events.on((event) => {
      if (!event.title) return
      const id = ++alertId.current
      setAlerts((current) => [
        ...current.slice(-2),
        { id, level: event.level ?? 'info', title: event.title!, message: event.message },
      ])
      window.setTimeout(() => setAlerts((current) => current.filter((alert) => alert.id !== id)), 5000)
    })
    return () => {
      window.clearInterval(timer)
      unsubscribe()
    }
  }, [simulation, store])

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null)
    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      if (document.fullscreenElement) void document.exitFullscreen()
    }
  }, [])

  const changeParam = useCallback(
    (key: string, value: ParamValue) => {
      setValues((current) => ({ ...current, [key]: value }))
      simulation?.setParam(key, value)
    },
    [simulation],
  )

  const reset = useCallback(() => {
    simulation?.reset()
    setAlerts([])
  }, [simulation])

  const randomize = useCallback(() => {
    const next = randomSeed()
    setSeed(next)
    simulation?.reset(next)
    setAlerts([])
  }, [simulation])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen?.()
  }, [])

  const copyLink = useCallback(async () => {
    const url = `${window.location.origin}/simulations/${definition.id}?seed=${seed}`
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      window.prompt('Copy this link', url)
    }
  }, [definition.id, seed])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isInteractive(event.target)) return
      switch (event.key) {
        case ' ':
          event.preventDefault()
          setPaused((value) => !value)
          break
        case 'r':
        case 'R':
          reset()
          break
        case 'f':
        case 'F':
          toggleFullscreen()
          break
        case 'd':
        case 'D':
          setDebug((value) => !value)
          break
        case 'Escape':
          // In fullscreen the browser handles Esc itself and this event never arrives.
          if (!document.fullscreenElement) void navigate('/', { viewTransition: true })
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navigate, reset, toggleFullscreen])

  const ready = status === 'ready'

  return (
    <main className="fixed inset-0 overflow-hidden">
      <div
        ref={setElement}
        className="absolute inset-0 touch-none"
        role="img"
        aria-label={`${definition.title} simulation. ${definition.summary}`}
        style={{ viewTransitionName: `sim-${definition.id}` }}
      />

      <div className="pointer-events-none absolute inset-0 flex flex-col">
        <div className="flex items-start justify-between gap-2 p-2.5 sm:p-5">
          {fullscreen ? (
            <span />
          ) : (
            <div className="pointer-events-auto min-w-0 max-w-[55vw] sm:max-w-md">
              <Link to="/" viewTransition className="lab-label hover:text-lab-bright">
                ← Simulation Lab
              </Link>
              <h1 className="mt-1 font-mono text-sm font-semibold uppercase tracking-[0.16em] text-lab-bright truncate sm:mt-2 sm:text-lg">
                <span className="mr-2 text-amber sm:mr-3">{definition.index}</span>
                {definition.title}
              </h1>
              <p className="mt-1 hidden text-sm leading-relaxed text-lab-dim sm:block">{definition.summary}</p>
              <div className="mt-1 flex items-center gap-2 sm:mt-2">
                <p className="lab-label text-[0.625rem] sm:text-[0.6875rem]">
                  Seed {seed}
                  {paused && <span className="ml-2 text-amber">Paused</span>}
                </p>
                <button
                  type="button"
                  onClick={() => setStatsOpen((v) => !v)}
                  className="lab-label ml-1 border border-lab-line px-1.5 py-0.5 text-amber hover:text-lab-bright sm:hidden"
                  aria-pressed={statsOpen}
                >
                  {statsOpen ? 'Hide Stats' : 'Stats'}
                </button>
              </div>
            </div>
          )}
          {ready && statsOpen && (
            <div className="pointer-events-auto shrink-0 max-w-[45vw] sm:max-w-none">
              <StatsPanel definition={definition} store={store} />
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-1 items-end justify-between gap-3 px-2 sm:items-start sm:px-5">
          {ready && panelOpen ? (
            <div className="pointer-events-auto max-h-[55vh] w-full overflow-y-auto rounded-t-lg border border-lab-line-strong bg-lab-panel/95 shadow-2xl backdrop-blur-md sm:max-h-full sm:w-72 sm:rounded-none sm:border-0 sm:bg-transparent sm:backdrop-blur-none">
              <ControlPanel definition={definition} values={values} onChange={changeParam} onClose={() => setPanelOpen(false)} />
            </div>
          ) : (
            <span />
          )}
          {ready && debug && simulation && slot && (
            <div className="pointer-events-auto hidden self-end sm:block">
              <DebugPanel simulation={simulation} slot={slot} seed={seed} />
            </div>
          )}
        </div>

        <div className="pointer-events-auto flex items-center gap-1.5 overflow-x-auto max-w-full px-2 py-2 sm:flex-wrap sm:justify-center sm:gap-2 sm:p-5 no-scrollbar">
          <button type="button" className="lab-btn !min-h-8 sm:!min-h-9 !px-2.5 sm:!px-3.5 text-[0.625rem] sm:text-[0.6875rem] shrink-0 sm:shrink" aria-pressed={paused} onClick={() => setPaused((value) => !value)}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="lab-btn !min-h-8 sm:!min-h-9 !px-2.5 sm:!px-3.5 text-[0.625rem] sm:text-[0.6875rem] shrink-0 sm:shrink" onClick={reset}>
            Reset
          </button>
          {definition.actions.map((action) => (
            <button
              key={action.key}
              type="button"
              className="lab-btn !min-h-8 sm:!min-h-9 !px-2.5 sm:!px-3.5 text-[0.625rem] sm:text-[0.6875rem] shrink-0 sm:shrink font-semibold text-amber border-amber/60"
              onClick={() => {
                simulation?.action(action.key)
                setPaused(false)
              }}
            >
              {action.label}
            </button>
          ))}
          <button type="button" className="lab-btn !min-h-8 sm:!min-h-9 !px-2.5 sm:!px-3.5 text-[0.625rem] sm:text-[0.6875rem] shrink-0 sm:shrink" onClick={randomize}>
            {definition.randomizeLabel}
          </button>
          <button type="button" className="lab-btn !min-h-8 sm:!min-h-9 !px-2.5 sm:!px-3.5 text-[0.625rem] sm:text-[0.6875rem] shrink-0 sm:shrink" onClick={() => controlsRef.current?.reset()}>
            Reset Cam
          </button>
          <button type="button" className="lab-btn !min-h-8 sm:!min-h-9 !px-2.5 sm:!px-3.5 text-[0.625rem] sm:text-[0.6875rem] shrink-0 sm:shrink" aria-pressed={panelOpen} onClick={() => setPanelOpen((value) => !value)}>
            Controls
          </button>
          {document.fullscreenEnabled && (
            <button type="button" className="lab-btn !min-h-8 sm:!min-h-9 !px-2.5 sm:!px-3.5 text-[0.625rem] sm:text-[0.6875rem] shrink-0 sm:shrink" onClick={toggleFullscreen}>
              {fullscreen ? 'Exit Full' : 'Fullscreen'}
            </button>
          )}
          <button type="button" className="lab-btn !min-h-8 sm:!min-h-9 !px-2.5 sm:!px-3.5 text-[0.625rem] sm:text-[0.6875rem] shrink-0 sm:shrink" onClick={() => void copyLink()}>
            {copied ? 'Copied' : 'Share'}
          </button>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-24 flex flex-col items-center gap-2 px-3" aria-live="polite">
        {alerts.map((alert) => (
          <div
            key={alert.id}
            className={`lab-panel max-w-sm px-4 py-2.5 ${alert.level === 'warn' ? '!border-signal-red/70' : '!border-signal-green/60'}`}
          >
            <p
              className={`font-mono text-xs font-semibold tracking-[0.14em] ${
                alert.level === 'warn' ? 'text-signal-red' : 'text-signal-green'
              }`}
            >
              {alert.level === 'warn' ? '⚠ ' : ''}
              {alert.title}
            </p>
            {alert.message && <p className="mt-1 text-xs text-lab-text">{alert.message}</p>}
          </div>
        ))}
      </div>

      <SimulationStatus status={status} summary={definition.summary} onReload={reload} />
    </main>
  )
}
