import { useEffect, useState } from 'react'

// Shared views service (same one the other portfolio experiments use).
const endpoint = 'https://views.fazleyrabbi.xyz'
const project = 'simulation-lab'
const cacheKey = 'simulation-lab:visits'
const sessionKey = 'simulation-lab:visitTracked'

function read(store: 'local' | 'session', key: string): string | null {
  try {
    return (store === 'local' ? localStorage : sessionStorage).getItem(key)
  } catch {
    return null
  }
}

function write(store: 'local' | 'session', key: string, value: string): void {
  try {
    ;(store === 'local' ? localStorage : sessionStorage).setItem(key, value)
  } catch {
    /* Storage can be disabled. */
  }
}

function isPreview(): boolean {
  const host = location.hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local') || location.port !== ''
}

function isAutomatedVisitor(): boolean {
  const agent = navigator.userAgent.toLowerCase()
  return (
    navigator.webdriver ||
    ['bot', 'spider', 'crawler', 'preview', 'lighthouse', 'headless', 'playwright', 'puppeteer', 'selenium', 'curl', 'wget', 'uptime'].some(
      (word) => agent.includes(word),
    )
  )
}

function cachedVisits(): number {
  const saved = Number(read('local', cacheKey))
  return Number.isSafeInteger(saved) && saved >= 0 ? saved : 0
}

let request: Promise<number | null> | null = null

/**
 * Counts one visit per browser session (never on localhost or bots) and
 * resolves with the total. Safe to call from anywhere; it only runs once.
 */
export function trackVisit(): Promise<number | null> {
  request ??= (async () => {
    const track = !isPreview() && !isAutomatedVisitor() && read('session', sessionKey) !== 'true'
    if (track) write('session', sessionKey, 'true')
    try {
      const route = track ? 'hit' : 'get'
      const response = await fetch(`${endpoint}/api/${route}?project=${project}&key=visitors`, {
        signal: AbortSignal.timeout(4000),
        cache: 'no-store',
      })
      if (!response.ok) return null
      const views: unknown = (await response.json())?.views
      if (typeof views !== 'number' || !Number.isSafeInteger(views) || views < 0) return null
      write('local', cacheKey, String(views))
      return views
    } catch {
      // Keep the last known count when offline.
      return null
    }
  })()
  return request
}

/** Total visits: the cached count immediately, then the live one. */
export function useVisits(): number {
  const [visits, setVisits] = useState(cachedVisits)
  useEffect(() => {
    let active = true
    void trackVisit().then((total) => {
      if (active && total !== null) setVisits(total)
    })
    return () => {
      active = false
    }
  }, [])
  return visits
}
