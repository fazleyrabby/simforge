interface Props {
  status: 'loading' | 'ready' | 'error'
  /** Text description shown with the error so the content is not lost without WebGL. */
  summary?: string
  onReload: () => void
}

/** Loading and error states drawn over a simulation slot. Never a blank canvas. */
export function SimulationStatus({ status, summary, onReload }: Props) {
  if (status === 'ready') return null

  if (status === 'loading') {
    return (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status">
        <div className="w-56">
          <p className="lab-label mb-2">Initializing simulation…</p>
          <div className="h-[3px] overflow-hidden bg-lab-line">
            <div className="h-full w-2/5 bg-amber" style={{ animation: 'lab-progress 1.1s linear infinite' }} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center p-6" role="alert">
      <div className="lab-panel max-w-sm p-5">
        <p className="font-mono text-xs font-semibold tracking-[0.16em] text-signal-red">SIMULATION ERROR</p>
        <p className="mt-2 text-sm text-lab-text">Unable to initialize this environment.</p>
        {summary && <p className="mt-2 text-sm text-lab-dim">{summary}</p>}
        <button
          type="button"
          className="lab-btn mt-4"
          onClick={(event) => {
            event.preventDefault()
            onReload()
          }}
        >
          Reload
        </button>
      </div>
    </div>
  )
}
