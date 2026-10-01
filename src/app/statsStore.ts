import type { StatValue } from '../simulations/core/Simulation'

export type Stats = Record<string, StatValue>

/**
 * Tiny external store for simulation statistics. The viewer polls the
 * simulation a few times a second and publishes here; only components that
 * subscribe re-render, and nothing in React updates per frame.
 */
export class StatsStore {
  private value: Stats = {}
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): Stats => this.value

  set(next: Stats): void {
    const keys = Object.keys(next)
    const changed = keys.length !== Object.keys(this.value).length || keys.some((key) => next[key] !== this.value[key])
    if (!changed) return
    this.value = next
    for (const listener of this.listeners) listener()
  }
}
