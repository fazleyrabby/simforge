import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { simulationMeta } from './src/data/simulationMeta.ts'
import { site } from './src/data/site.ts'

/**
 * Link unfurlers and crawlers do not run the app, so client-side meta tags
 * are invisible to them. After the build, write one HTML shell per route with
 * that route's title and description baked in.
 */
function routeShells(): Plugin {
  return {
    name: 'route-shells',
    apply: 'build',
    closeBundle() {
      const dist = join(import.meta.dirname, 'dist')
      const template = readFileSync(join(dist, 'index.html'), 'utf8')
      // Absolute base for og:image when deploying (unfurlers prefer absolute
      // URLs); falls back to root-relative paths when unset.
      const base = (process.env.SITE_URL ?? '').replace(/\/$/, '')
      const routes = [
        { path: 'simulations', title: 'Simulations', description: site.description, image: 'default' },
        { path: 'about', title: 'About', description: site.description, image: 'default' },
        ...simulationMeta.map((simulation) => ({
          path: `simulations/${simulation.id}`,
          title: simulation.title,
          description: simulation.summary,
          image: simulation.id,
        })),
      ]
      const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
      for (const route of routes) {
        const title = escape(`${site.name} — ${route.title}`)
        const description = escape(route.description)
        const image = `${base}/og/${route.image}.png`
        const url = `${base}/${route.path}`
        const html = template
          .replace(/<title>.*?<\/title>/, `<title>${title}</title>`)
          .replace(/(<meta name="description" content=")[^"]*/, `$1${description}`)
          .replace(/(<meta property="og:title" content=")[^"]*/, `$1${title}`)
          .replace(/(<meta property="og:description" content=")[^"]*/, `$1${description}`)
          .replace(/(<meta property="og:image" content=")[^"]*/, `$1${image}`)
          .replace(/(<meta name="twitter:title" content=")[^"]*/, `$1${title}`)
          .replace(/(<meta name="twitter:description" content=")[^"]*/, `$1${description}`)
          .replace(/(<meta name="twitter:image" content=")[^"]*/, `$1${image}`)
          .replace(/(<meta property="og:type" content=")[^"]*/, `$1website`)
          .replace(/<meta property="og:site_name"/, `<meta property="og:url" content="${url}" />\n    <meta property="og:site_name"`)
        mkdirSync(join(dist, route.path), { recursive: true })
        writeFileSync(join(dist, route.path, 'index.html'), html)
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), routeShells()],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
