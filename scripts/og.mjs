// Captures an Open Graph screenshot of each simulation from a running preview
// server. Run: node scripts/og.mjs [baseURL]
// Writes 1200×630 PNGs to public/og/, one per route plus a home default.
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://localhost:4173'
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'og')
mkdirSync(outDir, { recursive: true })

// id → preview seed, so each board shows the same world its card links to.
const shots = [
  { file: 'default', path: '/', warm: 3500 },
  { file: 'gears', path: '/simulations/gears?seed=48291', warm: 3500 },
  { file: 'heat', path: '/simulations/heat?seed=90417', warm: 5000 },
  { file: 'dyno', path: '/simulations/dyno?seed=2206', warm: 5000 },
  { file: 'factory', path: '/simulations/factory?seed=7312', warm: 6000 },
  { file: 'rack', path: '/simulations/rack?seed=5150', warm: 6000 },
  { file: 'orbital', path: '/simulations/orbital?seed=8814', warm: 5000 },
]

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
  ],
})
const context = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
const page = await context.newPage()

let failures = 0
for (const shot of shots) {
  await page.goto(base + shot.path, { waitUntil: 'networkidle' })
  await page.waitForSelector('canvas.stage-canvas', { timeout: 15000 })
  // Let the simulation initialise and run so the board shows a live state.
  await page.waitForTimeout(shot.warm)
  const out = join(outDir, `${shot.file}.png`)
  await page.screenshot({ path: out })
  const size = statSync(out).size
  const ok = size > 15000
  if (!ok) failures++
  console.log(`${ok ? 'ok ' : 'LOW'}  ${shot.file.padEnd(8)} ${(size / 1024).toFixed(0)} kB  ${shot.path}`)
}

await browser.close()
if (failures > 0) {
  console.error(`\n${failures} image(s) suspiciously small — WebGL may not be rendering.`)
  process.exit(1)
}
console.log('\nAll OG images captured.')
