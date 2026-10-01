import { useEffect, useState } from 'react'
import type { Simulation } from '../simulations/core/Simulation'
import { getStage, type Slot } from '../three/Stage'

interface Props {
  simulation: Simulation
  slot: Slot
  seed: number
}

function countObjects(simulation: Simulation): number {
  let count = 0
  simulation.scene.traverse(() => count++)
  return count
}

/** Development overlay, opened with ?debug=true or the D key. */
export function DebugPanel({ simulation, slot, seed }: Props) {
  const [, setTick] = useState(0)

  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 250)
    return () => window.clearInterval(timer)
  }, [])

  const info = getStage().info
  const rows: [string, string | number][] = [
    ['FPS', info.fps],
    ['Frame time', `${info.frameMs.toFixed(1)} ms`],
    ['Draw calls', info.drawCalls],
    ['Triangles', info.triangles.toLocaleString()],
    ['Objects', countObjects(simulation)],
    ['Geometries', info.geometries],
    ['Textures', info.textures],
    ['Programs', info.programs],
    ['Render scale', `${info.pixelRatio.toFixed(2)}×`],
    ['Simulation time', `${slot.simTime.toFixed(1)} s`],
    ['Active entities', simulation.entityCount()],
    ['Seed', seed],
  ]

  return (
    <aside aria-label="Debug information" className="lab-panel px-3 py-2">
      <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 font-mono text-[0.6875rem]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-lab-dim">{label}</dt>
            <dd className="text-right tabular-nums text-signal-green">{value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  )
}
