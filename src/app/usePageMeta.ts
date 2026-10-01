import { useEffect } from 'react'
import { site } from '../data/site'

function setMeta(selector: string, content: string): void {
  document.querySelector(selector)?.setAttribute('content', content)
}

/** Keeps the document title, description and share image in sync with the route. */
export function usePageMeta(title?: string, description: string = site.description, image = '/og/default.png'): void {
  useEffect(() => {
    const fullTitle = title ? `${site.name} — ${title}` : site.name
    document.title = fullTitle
    setMeta('meta[name="description"]', description)
    setMeta('meta[property="og:title"]', fullTitle)
    setMeta('meta[property="og:description"]', description)
    setMeta('meta[property="og:image"]', image)
    setMeta('meta[name="twitter:title"]', fullTitle)
    setMeta('meta[name="twitter:description"]', description)
    setMeta('meta[name="twitter:image"]', image)
  }, [title, description, image])
}
