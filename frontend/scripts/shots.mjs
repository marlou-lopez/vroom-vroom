// Screenshots of the running app for agents (vroom-pnw.47). Not a test: nothing in vitest or CI runs it.
//   npm run shots -- '/?debug=0' /sessions [--width 1600x900] [--out shots]
// Reuses a dev server on :5173, else starts Vite with the mock API and stops it afterwards.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const environment = process['env']
const PORT = Number(environment.SHOTS_PORT) || 5173
const BASE = `http://localhost:${PORT}`

// Headless Chromium hangs before rendering without this on WSL.
environment.DBUS_SESSION_BUS_ADDRESS ??= 'disabled:'

const args = process.argv.slice(2)
const targets = []
let size = '1600x900'
let out = 'shots'
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--width') size = args[++i]
  else if (a.startsWith('--width=')) size = a.slice(8)
  else if (a === '--out') out = args[++i]
  else if (a.startsWith('--out=')) out = a.slice(6)
  else targets.push(a)
}
if (!targets.length) {
  console.error('usage: npm run shots -- <path|url>... [--width 1600[x900]] [--out dir]')
  process.exit(2)
}
const m = /^(\d+)(?:x(\d+))?$/.exec(size)
if (!m) {
  console.error(`bad --width "${size}"; use 1600 or 1600x900`)
  process.exit(2)
}
const viewport = { width: +m[1], height: m[2] ? +m[2] : 900 }

async function up() {
  try {
    return (await fetch(BASE)).ok
  } catch {
    return false
  }
}

let server = null
function stop() {
  if (server) {
    try {
      process.kill(-server.pid)
    } catch {}
    server = null
  }
}

if (!(await up())) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    stdio: 'ignore',
    env: { ...environment, VITE_API: 'mock' },
    detached: true,
  })
  for (let i = 0; i < 120 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500))
  if (!(await up())) {
    stop()
    console.error('dev server did not start')
    process.exit(1)
  }
}

const dir = resolve(out)
mkdirSync(dir, { recursive: true })
let code = 0
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const ctx = await browser.newContext({ locale: 'en-US', viewport })
  for (const t of targets) {
    const url = /^https?:/.test(t) ? t : BASE + (t.startsWith('/') ? t : '/' + t)
    const page = await ctx.newPage()
    try {
      await page.goto(url, { waitUntil: 'load' })
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
      // Let canvases (uPlot, WebGL) get a size and a few frames drawn.
      await page
        .waitForFunction(
          () =>
            new Promise((ok) => {
              const cs = [...document.querySelectorAll('canvas')]
              if (cs.some((c) => c.width <= 1 || c.height <= 1)) return ok(false)
              requestAnimationFrame(() => requestAnimationFrame(() => ok(true)))
            }),
          null,
          { timeout: 15000 },
        )
        .catch(() => {})
      await page.waitForTimeout(500)
      const u = new URL(url)
      const name = u.pathname.replace(/^\/|\/$/g, '').replace(/\W+/g, '-') || 'home'
      const q = u.search.replace(/\W+/g, '-').replace(/^-|-$/g, '')
      const file = resolve(dir, `${name}${q ? '-' + q : ''}.png`)
      await page.screenshot({ path: file, timeout: 180000 })
      console.log(file)
    } catch (e) {
      console.error(`${t}: ${e.message}`)
      code = 1
    }
    await page.close()
  }
} finally {
  await browser.close()
  stop()
}
process.exit(code)
