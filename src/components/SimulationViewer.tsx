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
        <div className="flex items-start justify-between gap-3 p-3 sm:p-5">
          {fullscreen ? (
            <span />
          ) : (
            <div className="pointer-events-auto min-w-0 max-w-md">
              <Link to="/" viewTransition className="lab-label hover:text-lab-bright">
                ← Simulation Lab
              </Link>
              <h1 className="mt-2 font-mono text-base font-semibold uppercase tracking-[0.16em] text-lab-bright sm:text-lg">
                <span className="mr-3 text-amber">{definition.index}</span>
                {definition.title}
              </h1>
              <p className="mt-1 hidden text-sm leading-relaxed text-lab-dim sm:block">{definition.summary}</p>
              <p className="lab-label mt-2">
                Seed {seed}
                {paused && <span className="ml-3 text-amber">Paused</span>}
              </p>
            </div>
          )}
          {ready && (
            <div className="pointer-events-auto shrink-0">
              <StatsPanel definition={definition} store={store} />
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-1 items-end justify-between gap-3 px-3 sm:items-start sm:px-5">
          {ready && panelOpen ? (
            <div className="pointer-events-auto max-h-full w-full overflow-y-auto sm:w-72">
              <ControlPanel definition={definition} values={values} onChange={changeParam} />
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

        <div className="pointer-events-auto flex flex-wrap justify-center gap-2 p-3 sm:p-5">
          <button type="button" className="lab-btn" aria-pressed={paused} onClick={() => setPaused((value) => !value)}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="lab-btn" onClick={reset}>
            Reset
          </button>
          {definition.actions.map((action) => (
            <button
              key={action.key}
              type="button"
              className="lab-btn"
              onClick={() => {
                simulation?.action(action.key)
                setPaused(false)
              }}
            >
              {action.label}
            </button>
          ))}
          <button type="button" className="lab-btn" onClick={randomize}>
            {definition.randomizeLabel}
          </button>
          <button type="button" className="lab-btn" onClick={() => controlsRef.current?.reset()}>
            Reset Camera
          </button>
          <button type="button" className="lab-btn" aria-pressed={panelOpen} onClick={() => setPanelOpen((value) => !value)}>
            Controls
          </button>
          {document.fullscreenEnabled && (
            <button type="button" className="lab-btn" onClick={toggleFullscreen}>
              {fullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            </button>
          )}
          <button type="button" className="lab-btn" onClick={() => void copyLink()}>
            {copied ? 'Copied' : 'Copy Link'}
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
