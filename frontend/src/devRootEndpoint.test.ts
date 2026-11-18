import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { describe, expect, it } from 'vitest'
import { DEV_ROOT_PATH, devRootEndpoint } from '../vite-dev-root.ts'

const root = realpathSync(resolve(__dirname, '..'))

describe('dev root endpoint (vroom-pnw.67)', () => {
  it('a dev server tells which frontend folder it serves', async () => {
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { port: 0, host: '127.0.0.1' },
      plugins: [devRootEndpoint()],
    })
    await server.listen()
    try {
      const addr = server.httpServer!.address() as { port: number }
      const res = await fetch(`http://127.0.0.1:${addr.port}${DEV_ROOT_PATH}`)
      expect(await res.text()).toBe(root)
    } finally {
      await server.close()
    }
  })

  it('applies to the dev server only, so a production build never gets it', () => {
    expect(devRootEndpoint().apply).toBe('serve')
  })
})
