import { useEffect } from 'react'
import { site } from '../data/site'

function setMeta(selector: string, content: string): void {
  document.querySelector(selector)?.setAttribute('content', content)
}

/** Keeps the document title and description in sync with the current route. */
export function usePageMeta(title?: string, description: string = site.description): void {
  useEffect(() => {
    const fullTitle = title ? `${site.name} — ${title}` : site.name
    document.title = fullTitle
    setMeta('meta[name="description"]', description)
    setMeta('meta[property="og:title"]', fullTitle)
    setMeta('meta[property="og:description"]', description)
  }, [title, description])
}
