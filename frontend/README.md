# Frontend

React 18 + TypeScript + Vite app for the vroom-vroom telemetry coach. Run all commands from
this directory. Install dependencies once with `npm ci`.

## Commands

```bash
npm run dev       # dev server at http://localhost:5173
npm run test      # vitest (single run)
npm run lint      # oxlint
npm run build     # tsc -b && vite build
npm run preview   # serve the production build
```

## Mock API

`.env.development` sets `VITE_API=mock`. With it, `npm run dev` starts an MSW service worker
that answers `/api/*` from `src/api/mock/`. The mock is built on one real Spa recording,
`public/mock/spa-2026-11-03.json`.

The Vite dev server also proxies `/api` to `127.0.0.1:8765`, where the future backend will
run.

## Debug tools

The detailed track view shows a frame-rate HUD, a benchmark, a line-source selector and a GPU
context-loss test only in `npm run dev` or when the URL has `?debug`. Use `?debug=0` in dev to
preview the production view.

## Source layout

| Path | What |
|---|---|
| `src/api/` | The API contract (`types.ts`, `client.ts`) and the MSW mock in `mock/` |
| `src/pages/` | Telemetry (home), Sessions, Tracks |
| `src/components/` | UI components, including the track panel views |
| `src/lib/` | Pure, unit-tested logic: playback, track map projection, strips, formatting |
| `src/state/` | Zustand playback store, data and coach hooks |

Components reach data only through the `Api` interface in `src/api/client.ts`.

## Naming rule

Do not use tracking-like words in file or folder names: `trackview`, `tracking`, `analytics`,
`beacon`, `pixel`. Ad blockers block those module URLs in `npm run dev`, which leaves a white
page.
