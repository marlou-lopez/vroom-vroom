// Screenshots of the running app for agents (vroom-pnw.47). Not a test: nothing in vitest or CI runs it.
//   npm run shots -- '/?debug=0' /sessions [--width 1600x900] [--out shots]
// Reuses a dev server on :5173 only if it serves THIS frontend folder (vroom-pnw.67); otherwise starts Vite with the
// mock API on a free port and stops it afterwards. SHOTS_PORT names a server explicitly: it must serve this folder
// too, unless --any-server is given.
import { spawn } from 'node:child_process'
import { mkdirSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const environment = process['env']
const OWN_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
// Served by the devRootEndpoint plugin in vite.config.ts (dev only). Keep in sync with vite-dev-root.ts.
const ROOT_PATH = '/__vroom-root'
const EXPLICIT_PORT = Number(environment.SHOTS_PORT) || 0
let PORT = EXPLICIT_PORT || 5173
let BASE = `http://localhost:${PORT}`

// Headless Chromium hangs before rendering without this on WSL.
environment.DBUS_SESSION_BUS_ADDRESS ??= 'disabled:'

const args = process.argv.slice(2)
const targets = []
let size = '1600x900'
let out = 'shots'
let anyServer = false
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--width') size = args[++i]
  else if (a.startsWith('--width=')) size = a.slice(8)
  else if (a === '--out') out = args[++i]
  else if (a.startsWith('--out=')) out = a.slice(6)
  else if (a === '--any-server') anyServer = true
  else targets.push(a)
}
if (!targets.length) {
  console.error('usage: npm run shots -- <path|url>... [--width 1600[x900]] [--out dir] [--any-server]')
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

// The frontend folder the server on BASE serves: null when it doesn't answer or is a Vite without the endpoint.
async function serverRoot() {
  try {
    const res = await fetch(BASE + ROOT_PATH)
    const text = (await res.text()).trim()
    return res.ok && text.startsWith('/') ? text : null
  } catch {
    return null
  }
}

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => ok(port))
    })
  })
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

let reuse = false
if (await up()) {
  const root = await serverRoot()
  if (root === OWN_ROOT || anyServer) reuse = true
  else if (EXPLICIT_PORT) {
    console.error(
      `the dev server on port ${PORT} serves ${root ?? 'an unknown folder (no /__vroom-root endpoint)'}, not ${OWN_ROOT}. ` +
        'Its code is not this checkout\'s. Stop it, unset SHOTS_PORT, or pass --any-server to screenshot it anyway.',
    )
    process.exit(2)
  }
}
if (!reuse) {
  // Nothing of ours to reuse: start our own on a free port, never on someone else's 5173.
  PORT = EXPLICIT_PORT && !(await up()) ? EXPLICIT_PORT : await freePort()
  BASE = `http://localhost:${PORT}`
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

console.error(`${server ? 'started own dev server' : 'reusing dev server'} on ${BASE} (${OWN_ROOT})`)
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
