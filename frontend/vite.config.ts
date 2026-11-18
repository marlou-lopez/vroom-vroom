import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vitest/config'
import { devRootEndpoint } from './vite-dev-root.ts'

/**
 * Vite copies all of public/ into dist/. Two folders there are for development only: the mock API's recordings with
 * its service worker (mock/, mockServiceWorker.js) and the git-ignored car-model fallback (local-models/, which may hold
 * a user's licensed model). Remove them from the production output; `npm run dev` still serves them from public/.
 */
const DEV_ONLY_PUBLIC = ['mock', 'mockServiceWorker.js', 'local-models'] as const

function stripDevOnlyPublicFiles(): Plugin {
  let outDir = ''
  return {
    name: 'strip-dev-only-public-files',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      for (const name of DEV_ONLY_PUBLIC) rmSync(resolve(outDir, name), { recursive: true, force: true })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), stripDevOnlyPublicFiles(), devRootEndpoint()],
  // The model converter is a module worker that imports its heavy parts lazily, which needs the ES worker format.
  worker: { format: 'es' },
  server: {
    // Unused while VITE_API=mock; the real backend listens on 127.0.0.1:8765.
    proxy: { '/api': 'http://127.0.0.1:8765' },
  },
  test: {
    // Two projects: `*.test.ts` run in node (pure logic, MSW over node fetch); `*.test.tsx` run in jsdom.
    projects: [
      {
        extends: true,
        test: { name: 'node', environment: 'node', include: ['src/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          environmentOptions: { jsdom: { url: 'http://localhost/' } },
          include: ['src/**/*.test.tsx'],
          setupFiles: ['src/test/setupDom.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'text', 'html'],
      reportsDirectory: 'coverage',
    },
  },
})
