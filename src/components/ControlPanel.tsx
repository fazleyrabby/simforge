import type { ParamDefinition, SimulationDefinition } from '../simulations/core/registry'
import type { ParamValue } from '../simulations/core/Simulation'

interface Props {
  definition: SimulationDefinition
  values: Record<string, ParamValue>
  onChange: (key: string, value: ParamValue) => void
  onClose?: () => void
}

function formatValue(param: ParamDefinition, value: number): string {
  const step = param.step ?? 1
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2
  return value.toFixed(digits)
}

/** Generated from the registry's param schema; simulations have no hand-written panels. */
export function ControlPanel({ definition, values, onChange, onClose }: Props) {
  return (
    <section aria-label={`${definition.title} controls`} className="lab-panel lab-ticks relative p-3 sm:p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="lab-label !text-lab-text">{definition.title} control</h2>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="lab-label flex items-center gap-1 border border-lab-line px-2 py-0.5 text-amber hover:text-lab-bright sm:hidden"
            aria-label="Close controls"
          >
            ✕ Close
          </button>
        )}
      </div>
      <div className="flex flex-col gap-3">
        {definition.params.map((param) => {
          const id = `param-${definition.id}-${param.key}`
          const value = values[param.key]

          if (param.type === 'range') {
            const min = param.min ?? 0
            const max = param.max ?? 1
            const number = Number(value)
            return (
              <div key={param.key}>
                <div className="flex items-baseline justify-between">
                  <label htmlFor={id} className="lab-label">
                    {param.label}
                  </label>
                  <output htmlFor={id} className="font-mono text-xs tabular-nums text-lab-bright">
                    {formatValue(param, number)}
                    {param.unit && <span className="ml-1 text-lab-dim">{param.unit}</span>}
                  </output>
                </div>
                <input
                  id={id}
                  type="range"
                  className="lab-range"
                  min={min}
                  max={max}
                  step={param.step ?? 1}
                  value={number}
                  style={{ '--fill': `${((number - min) / (max - min)) * 100}%` } as React.CSSProperties}
                  onChange={(event) => onChange(param.key, Number(event.target.value))}
                />
              </div>
            )
          }

          if (param.type === 'toggle') {
            return (
              <div key={param.key} className="flex items-center justify-between gap-3">
                <span id={id} className="lab-label">
                  {param.label}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(value)}
                  aria-labelledby={id}
                  className="lab-btn !min-h-7 w-14"
                  onClick={() => onChange(param.key, !value)}
                >
                  {value ? 'On' : 'Off'}
                </button>
              </div>
            )
          }

          const options = param.options ?? []
          const isCompact = options.length <= 3 || (options.length === 4 && options.every((o) => o.label.length <= 4))

          if (!isCompact) {
            return (
              <div key={param.key}>
                <label htmlFor={id} className="lab-label mb-1.5 block">
                  {param.label}
                </label>
                <div className="relative">
                  <select
                    id={id}
                    className="lab-select"
                    value={String(value)}
                    onChange={(event) => onChange(param.key, event.target.value)}
                  >
                    {options.map((option) => (
                      <option key={option.value} value={option.value} className="bg-lab-card text-lab-bright">
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-lab-dim">
                    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  </div>
                </div>
              </div>
            )
          }

          return (
            <div key={param.key} role="radiogroup" aria-labelledby={id}>
              <span id={id} className="lab-label mb-1.5 block">
                {param.label}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={value === option.value}
                    className="lab-btn !min-h-7 flex-1 !px-2 text-center text-xs truncate"
                    title={option.label}
                    onClick={() => onChange(param.key, option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      {definition.hint && <p className="mt-3 text-xs leading-relaxed text-lab-dim">{definition.hint}</p>}
    </section>
  )
}
