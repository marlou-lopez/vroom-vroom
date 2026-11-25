# Frontend

React 18 + TypeScript + Vite app for the vroom-vroom telemetry coach. Run all commands from
this directory. Install dependencies once with `npm ci`.

## Commands

```bash
npm run dev       # dev server at http://localhost:5173
npm run test      # vitest (single run): *.test.ts in node, *.test.tsx in jsdom
npm run test:coverage  # tests with v8 coverage, report in coverage/
npm run lint      # oxlint
npm run build     # tsc -b && vite build
npm run preview   # serve the production build
```

## Real API and mock API

`.env.development` sets `VITE_API=real`: `npm run dev` talks to the backend, which Vite proxies
from `/api` to `127.0.0.1:8765` (start it first, see the root README).

`VITE_API=mock npm run dev` starts an MSW service worker instead, answering `/api/*` from
`src/api/mock/`. The mock is built on real recordings in `public/mock/`: Spa
(`spa-2026-11-03.json`, with its elevation and edge survey) and Monza (`monza-2026-11-05.json`).
`npm run shots` starts its own mock server unless a dev server for this folder is already on 5173
(that one keeps whatever `VITE_API` it was started with).

`npm run gen:api` regenerates `src/api/schema.gen.ts` from the running backend's
`/openapi.json`. `src/api/contract.test.ts` checks that every route and request body in
`client.ts` / `types.ts` exists in that schema. The backend routes have no response models yet, so
response shapes are not checked.

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
