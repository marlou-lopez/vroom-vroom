import { realpathSync } from 'node:fs'
import type { Plugin } from 'vite'

/** Path `npm run shots` asks a dev server on, to learn whose code it serves (vroom-pnw.67). Keep in sync with scripts/shots.mjs. */
export const DEV_ROOT_PATH = '/__vroom-root'

/**
 * Dev-only: answers `GET /__vroom-root` with the frontend folder this Vite serves, so a script can tell its own server
 * from another worktree's. `apply: 'serve'` keeps it out of `npm run build`; it adds no file to dist/.
 */
export function devRootEndpoint(): Plugin {
  return {
    name: 'dev-root-endpoint',
    apply: 'serve',
    configureServer(server) {
      const root = realpathSync(server.config.root)
      server.middlewares.use(DEV_ROOT_PATH, (_req, res) => {
        res.setHeader('content-type', 'text/plain')
        res.setHeader('cache-control', 'no-store')
        res.end(root)
      })
    },
  }
}
