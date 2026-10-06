import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

// Start vite dev
const dev = spawn('pnpm', ['dev', '--port', '5183'], {
  stdio: 'pipe',
})

// Wait for dev server to be ready
await new Promise((resolve) => {
  dev.stdout.on('data', (d) => {
    if (d.toString().includes('5183')) resolve(null)
  })
  setTimeout(resolve, 3000)
})

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
  ],
})

const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })

async function getStats() {
  return await page.evaluate(() => {
    const stage = window.__stage
    if (!stage) return null
    return {
      geometries: stage.renderer.info.memory.geometries,
      textures: stage.renderer.info.memory.textures,
      programs: stage.renderer.info.programs?.length ?? 0,
      calls: stage.info.drawCalls,
    }
  })
}

try {
  console.log('Navigating to Home...')
  await page.goto('http://localhost:5183/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  const homeBaseline = await getStats()
  console.log('Home baseline:', homeBaseline)

  const sims = ['gears', 'heat', 'dyno', 'factory', 'rack', 'orbital', 'press', 'warehouse', 'tunnel', 'seismic', 'maglev', 'arm', 'machine']
  
  for (let cycle = 1; cycle <= 2; cycle++) {
    console.log(`\n--- Cycle ${cycle} ---`)
    for (const sim of sims) {
      await page.goto(`http://localhost:5183/simulations/${sim}`, { waitUntil: 'networkidle' })
      if (cycle === 1 && sim === 'gears') {
        const soundBtn = await page.$('button[aria-label="Unmute audio"]')
        if (soundBtn) {
          await soundBtn.click()
          console.log('Toggled Sound ON successfully')
        }
      }
      await page.waitForTimeout(1000)
      const simStats = await getStats()
      console.log(`Sim ${sim.padEnd(8)}:`, simStats)

      await page.goto('http://localhost:5183/', { waitUntil: 'networkidle' })
      await page.waitForTimeout(1000)
      const afterHome = await getStats()
      console.log(`Back Home:    `, afterHome)
    }
  }

  const finalStats = await getStats()
  console.log('\nFinal Home Stats:', finalStats)
} finally {
  await browser.close()
  dev.kill()
  process.exit(0)
}
