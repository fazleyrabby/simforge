// Builds the site's cover image (public/og/cover.png): the brand line beside a
// mosaic of every simulation, each tile a real capture of its live homepage card.
// Needs a running preview server. Run: node scripts/og-cover.mjs [baseURL]
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://localhost:4173'
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'og')
mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})

// 1. Capture each card from the live homepage, with its text overlay hidden.
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 })
const page = await context.newPage()
await page.goto(base + '/', { waitUntil: 'networkidle' })
await page.waitForSelector('canvas.stage-canvas', { timeout: 15000 })
await page.addStyleTag({
  content: `a[href^="/simulations/"] > *:not(:first-child) { visibility: hidden !important; }
            a[href^="/simulations/"] { border-color: transparent !important; }
            a[href^="/simulations/"]::before, a[href^="/simulations/"]::after { display: none !important; }`,
})
const cards = page.locator('a[href^="/simulations/"]')
const count = await cards.count()
const tiles = []
for (let i = 0; i < count; i++) {
  const card = cards.nth(i)
  await card.scrollIntoViewIfNeeded()
  // Let the world run: off-screen cards are paused until they scroll into view.
  await page.waitForTimeout(6000)
  const href = await card.getAttribute('href')
  const label = await card.getAttribute('aria-label')
  const box = await card.boundingBox()
  const shot = await page.screenshot({ clip: box })
  tiles.push({
    id: href.split('/')[2].split('?')[0],
    title: label.replace('Open simulation: ', '').split('.')[0],
    data: shot.toString('base64'),
  })
  console.log(`captured ${tiles[i].id}`)
}
await context.close()

// 2. Compose the cover.
const cover = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
const board = await cover.newPage()
const columns = 3
const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1200px; height: 630px; background: #0a0c0f; color: #c3cbd4; font-family: "IBM Plex Sans", sans-serif; display: flex; overflow: hidden; }
  .left { width: 452px; padding: 52px 0 46px 56px; display: flex; flex-direction: column; }
  .brand { font: 600 17px "IBM Plex Mono", monospace; letter-spacing: 0.26em; color: #eef2f6; display: flex; align-items: center; gap: 12px; }
  .brand i { width: 9px; height: 9px; background: #ffb020; display: block; }
  h1 { margin-top: 62px; font-weight: 500; font-size: 60px; line-height: 1.07; letter-spacing: -0.02em; color: #eef2f6; }
  h1 span { color: #7a8591; }
  .meta { margin-top: auto; font: 500 13px "IBM Plex Mono", monospace; letter-spacing: 0.16em; text-transform: uppercase; color: #7a8591; line-height: 2; }
  .meta b { color: #ffb020; font-weight: 500; }
  .right { flex: 1; padding: 34px 36px 34px 20px; display: grid; grid-template-columns: repeat(${columns}, 1fr); gap: 10px; }
  .tile { position: relative; border: 1px solid #242b34; overflow: hidden; background: #0a0c0f; }
  .tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .tile::before { content: ""; position: absolute; top: -1px; left: -1px; width: 9px; height: 9px; border-top: 1px solid #7a8591; border-left: 1px solid #7a8591; z-index: 2; }
  .tag { position: absolute; left: 9px; top: 8px; font: 500 10px "IBM Plex Mono", monospace; letter-spacing: 0.16em; text-transform: uppercase; color: #eef2f6; text-shadow: 0 0 6px #0a0c0f, 0 0 6px #0a0c0f; }
  .tag b { color: #ffb020; font-weight: 500; margin-right: 7px; }
</style></head><body>
  <div class="left">
    <div class="brand"><i></i>SIMULATION LAB</div>
    <h1>Small worlds.<br>Real systems.<br><span>Running in<br>your browser.</span></h1>
    <div class="meta"><b>${tiles.length}</b> live simulations<br>Built with Three.js</div>
  </div>
  <div class="right">
    ${tiles
      .map(
        (tile, i) => `<div class="tile"><img src="data:image/png;base64,${tile.data}"><div class="tag"><b>${String(i + 1).padStart(2, '0')}</b>${tile.title}</div></div>`,
      )
      .join('')}
  </div>
</body></html>`
await board.setContent(html, { waitUntil: 'networkidle' })
await board.evaluate(() => document.fonts.ready)
const file = join(outDir, 'cover.png')
await board.screenshot({ path: file })
await browser.close()
console.log(`ok   cover  ${Math.round(statSync(file).size / 1024)} kB`)
