import { useCallback, useEffect, useRef, useState } from 'react'
import type { SimulationDefinition } from '../simulations/core/registry'
import type { ParamValue, Quality, Simulation } from '../simulations/core/Simulation'
import { getStage, isLowSpec, prefersReducedMotion, type Slot } from '../three/Stage'

export interface SimulationHandle {
  status: 'loading' | 'ready' | 'error'
  simulation: Simulation | null
  slot: Slot | null
  reload: () => void
}

/**
 * Loads a simulation's code, initializes it and mounts it on the shared stage
 * inside `element`. Unmounting removes the slot and disposes the simulation.
 */
export function useSimulation(
  definition: SimulationDefinition,
  element: HTMLElement | null,
  quality: Quality,
  seed: number,
  params: Record<string, ParamValue>,
): SimulationHandle {
  const [state, setState] = useState<Omit<SimulationHandle, 'reload'>>({
    status: 'loading',
    simulation: null,
    slot: null,
  })
  const [attempt, setAttempt] = useState(0)
  // Seed and params are read once at init; later changes go through reset / setParam.
  const initial = useRef({ seed, params })
  initial.current = { seed, params }

  useEffect(() => {
    if (!element) return
    let cancelled = false
    let simulation: Simulation | null = null
    let slot: Slot | null = null
    setState({ status: 'loading', simulation: null, slot: null })

    const start = async () => {
      const stage = getStage()
      const module = await definition.load()
      if (cancelled) return
      simulation = new module.default()
      for (const [key, value] of Object.entries(initial.current.params)) simulation.setParam(key, value)
      await simulation.init({
        renderer: stage.renderer,
        quality,
        seed: initial.current.seed,
        mobile: isLowSpec(),
        reducedMotion: prefersReducedMotion(),
        element,
      })
      if (cancelled) {
        simulation.dispose()
        return
      }
      slot = stage.addSlot(element, simulation)
      setState({ status: 'ready', simulation, slot })
    }

    start().catch((error: unknown) => {
      if (import.meta.env.DEV) console.error(`[${definition.id}] simulation failed to initialize`, error)
      simulation?.dispose()
      simulation = null
      if (cancelled) return
      setState({ status: 'error', simulation: null, slot: null })
    })

    return () => {
      cancelled = true
      if (slot) {
        getStage().removeSlot(slot)
        simulation?.dispose()
      }
    }
  }, [definition, element, quality, attempt])

  const reload = useCallback(() => setAttempt((value) => value + 1), [])
  return { ...state, reload }
}
