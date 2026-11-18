# vroom-vroom: AI sim racing engineer

A personal telemetry coach for **Le Mans Ultimate (LMU)**. It imports LMU's own `.duckdb`
recordings, aligns laps on a 1 m distance grid, plays a lap against a reference lap, and has
an LLM coach annotate where time was lost. The data model is meant to work for any sim, not
just LMU. Stages: **v1** UI on mock data (current), **v2** real backend, **v3** live voice coaching
through a Windows agent, **v4** conversation, **v5** setup engineer. A side milestone, **Pedal scaling**, scales the
brake pedal per car in LMU and other sims (via SimHub).

## Where things stand

**Beads (`bd`) is the source of truth for status.** The repo `marlou-lopez/vroom-vroom` is public,
and GitHub Issues is disabled. Before starting, run `bd ready --exclude-type epic` for the queue and
`bd list --status in_progress,review` for work in flight. Each milestone is a Beads epic (`bd list -t
epic`). Each issue stands on its own and lists its dependencies. Don't rely on this file for progress.

This section only records facts that change rarely (last checked 2026-11-18):
- **Phase:** the frontend runs on a mock API serving real Spa and Monza recordings. The backend
  hasn't been started, and there's no `backend/` directory yet.
- **Agreed order:** the **Track views** milestone (detailed 2D, then 3D) closed on 2026-11-12. Next
  are the remaining `v1 – UI on mock data` issues, then the `Analysis features` milestone (new analysis
  split out of v1 on 2026-11-07), then the backend (milestone `v2 – Real backend`, Tasks 1–13), then
  switching the frontend to the real API. v1 and Analysis features are both done before the backend
  starts; the backend scaffold issue depends on both epics in Beads, so `bd ready` reflects that.
  **Pedal scaling** (`vroom-ryg`, decided 2026-11-14) doesn't wait for the backend: its core may start
  after Analysis features, alongside v2. Goals, non-goals and milestones are in `docs/spec.md`.
- The design spec, the v1 plan and handover notes live outside the repo, in
  `~/.claude/plans/superpowers/ai-sim-racing-engineer/`. The Beads issues and `docs/spec.md`
  already copy the details that matter.

## Layout

| Path | What |
|---|---|
| `frontend/` | React 18 + TypeScript (~5.9) + Vite app |
| `frontend/src/api/types.ts`, `client.ts` | **The API contract.** The future backend must match it |
| `frontend/src/api/mock/` | MSW mock API built on real laps: Spa (`public/mock/spa-2026-11-03.json`) and Monza (`monza-2026-11-05.json`). Spa also has the edge survey and elevation; Monza has only the centreline. The Monza race of 9 Nov 2026 (`monza-stint-2026-11-09.json`, stint stats only) is a Race session with lap metadata and no traces (`LapMeta.has_trace` false), served with its stints by `GET /sessions/{id}/stints` (vroom-bi4.4); the Spa race of 10 Nov 2026 (`spa-race-2026-11-10.json` and `spa-race-stint-2026-11-10.json`, GT3, one stop) has a 1 m trace for every one of its 9 laps, per-lap stint stats, the recorded setup, `setting_events` (in-car ABS/TC/fuel-map changes with lap, distance and time, vroom-bi4.10) and per-lap `aid_activation` (see `recording.ts` for the shapes) |
| `frontend/src/pages/` | Telemetry (home, `/`), Sessions, Tracks (labelled map and corner table; the landmark editor and re-calibration sit behind an "Advanced" control, closed by default, remembered in localStorage by `lib/tracksAdvanced.ts`, vroom-xg2). The Stint view on Sessions opens with a one-sentence summary (`stintSentence` in `lib/stint.ts`) and keeps the fit formula behind "How is this worked out" |
| `frontend/src/lib/` | Pure logic: playback, track map projection, strips, formatting, car attitude estimate for the cockpit camera (unit-tested) |
| `frontend/src/state/` | Zustand playback store, data and coach hooks |
| `frontend/src/components/mapviews/` | Track panel views (classic 2D SVG, detailed 2D on WebGL, experimental 3D ribbon in `ribbon/`, with chase, cockpit, orbit and top cameras) behind one `TrackViewProps` interface (elevation, edges and kerbs reach them as `geometry`, from `api.trackGeometry` once per track, not from the comparison; null means a flat track without edges); `shared/` holds what the WebGL views have in common (badge layer, ring buffer, storage helpers, `useGpuRenderer` for the renderer lifecycle, context loss and resize, `useBenchHud` for the frame-rate HUD and benchmark) |
| `frontend/public/local-models/` | **Git-ignored** developer-fallback folder for 3D car models, `<car_id>.glb` (#102). Only its `README.md` is committed. The 3D view's lookup order is the user's model stored in the browser (IndexedDB, loaded in the 3D view's Car popover, which converts raw glTF folders, zips and large .glb files in a Web Worker), then this folder, then the box. Never commit a model, its textures or a converted copy (licence) |
| `docs/lmu-duckdb-schema.md` | **Verified LMU recording facts**: they override any assumption in plans or issues |
| `docs/track-views/` | Spike write-ups and decisions for the Track views milestone (e.g. `edge-survey.md`, `elevation-shared-memory.md`) |
| `tools/extract-laps.mjs` | Turns an LMU `.duckdb` into the mock JSON: `node extract-laps.mjs <copy.duckdb> <out.json> "<source label>" [laps]` (needs `npm i @duckdb/node-api`); also writes `initial_settings`, `setting_events` and each lap's `aid_activation` |
| `tools/extract-stint.py` | Per-lap stint stats (fuel, virtual energy, tyres, brakes) from an LMU `.duckdb` copy, for the Stint view: `uv run --with duckdb python -I extract-stint.py <copy.duckdb> <out.json> "<label>"` (vroom-pnw.26) |
| `tools/fuel-effect-fit.py` | Fits the fuel-weight effect (s/kg per lap) and tyre fall-off across a car's sessions at one track with different fuel loads: `uv run --with duckdb --with numpy python -I tools/fuel-effect-fit.py <telemetry dir> <scratch dir> "<track prefix>" "<car prefix>" [PQR]` (copies each recording first; vroom-d4g) |
| `docs/ui-review/` | Whole-app UI review (vroom-pnw.30): ranked findings, screenshots in `img/`, three UI directions and the workspace prototype; `novice-review.md` is the first-time-user review (vroom-pnw.50, screenshots `img/novice-*`) |
| `docs/stint/` | Stint view spike write-ups (`stint-view.md`, `fuel-corrected-falloff.md`) |
| `docs/session-report/` | Session report (vroom-bi4.11): `windows.md` lists the tyre and brake working windows per car class with their sources (editable assumptions; `frontend/src/lib/reportWindows.ts` holds the same table). The report is `GET /sessions/{id}/report` (`Api.sessionReport`), built by `lib/sessionReport.ts`. `suggestions.md` is the setup-suggestion spike (vroom-k5s.2) |
| `tools/measure-windows.py` | Measures the session report's tyre and brake working windows per car class from your own recordings (fastest 20 % of each car-and-track's flying laps, p10 to p90; copies each recording first): `uv run --with duckdb --with numpy python -I tools/measure-windows.py <Telemetry folder> <scratch dir>`. A class needs 30 laps from 2 tracks, otherwise its values stay assumptions (vroom-0dg) |
| `docs/car-behaviour/` | Under/oversteer spike write-up (`oversteer-understeer.md`, vroom-pnw.15); its truth check is `tools/lmu-logger/balance_check.py` (recording grid against a capture of the same session) |
| `tools/lmu-logger/` | Windows-only Python logger that records LMU's shared memory to `.lmucap` files (player-only by default), plus a reader, a header parser (`layout.py`, reads the layout from your own LMU install: no struct copies, licence) and `decode.py` (`layout`, `player`, `track`, `survey`) (#94, #97). Captures stay out of git |
| `tools/lmu-recorder-channels.py` | Lists the channel names LMU's built-in recorder knows (read from the game exe) and diffs them with `config.json`: `python3 -I tools/lmu-recorder-channels.py [--check "<name>" ...]`. Re-run after an LMU update (vroom-pnw.16, `docs/lmu-channels.md`) |
| `tools/optimize-car-model.mjs` | Command-line twin of the Car popover's in-browser converter: turns a downloaded car glTF (folder, zip, .gltf, .glb) into one small GLB for `frontend/public/local-models/`. Imports `frontend/src/components/mapviews/ribbon/convert/` (the shared drop list, settings and pipeline; needs `npm ci` in `frontend/`, and network once for `sharp`). Its output is never committed (#102, `docs/track-views/car-model.md`) |
| `spikes/local-llm/` | Coach LLM bench, from the local-LLM spike (vroom-9ki.17): facts packets from any mock recording (`build-packets.mjs --track`), models in `models.json` (Ollama, OpenAI or any OpenAI-compatible host, Anthropic), number guard, prose and hedge checks, round-tagged runs, blind rating and scoring (`summarize.py`). Scripts, not tests: they call real models and spend money. Steps in its `README.md`, results in `docs/coach-llm/local-llm-spike.md` |
| `docs/spec.md` | Product spec: goals, non-goals, milestones as Beads epics, order of work |
| `.claude/dispatch-loop.json` | Dispatch Loop config: the quality commands `/dl:ship` runs |

The planned backend is a Python package `racecoach` in `backend/` (uv, FastAPI, DuckDB,
polars, Pydantic AI), serving `127.0.0.1:8765`.

## Commands (run in `frontend/`)

```bash
npm run dev     # http://localhost:5173; VITE_API=mock in .env.development starts MSW
npm run test    # vitest
npm run test:coverage  # vitest with v8 coverage, report in coverage/
npm run lint    # oxlint
npm run shots -- '/?debug=0' /sessions   # PNG screenshots of app paths (see below)
npm run build   # tsc -b && vite build
```

Tests named `*.test.ts` run in node and `*.test.tsx` run in jsdom (setup in `src/test/setupDom.ts`; MSW mock server helpers in `src/test/mockServer.tsx`).

CI (`.github/workflows/ci.yml`) runs lint, test and build on every PR and push to `main`.

The detailed 2D and 3D track views show their frame-rate HUD, benchmark and GPU context-loss test (and the 2D one its line-source selector) only in `npm run dev` or with `?debug` in the URL; `?debug=0` hides them in dev to preview the production view. The Balance strip (Strips menu), understeer marks on the steering strip and the understeer tint on the classic map are on by default and read the API's `lap_balance` and runs (vroom-bi4.6; the client no longer estimates). `?balance` adds the experimental oversteer marks (the contract's `lap_oversteer_runs`, high precision but low recall). The Simple/Full switch in the header (a `HeaderSlot` from the Telemetry page, remembered in localStorage by `lib/uiMode.ts`; the full view is the first-visit default) shows the Simple view (plain-language biggest losses and tips for a first-time user, `src/components/simple/`, vroom-pnw.50, vroom-pnw.56); its "Replay this corner" switches to the full view at that corner. `?mirror=0` turns off the 3D cockpit's live rear-view mirror (a second render pass; the glass then shows a still picture), to measure its cost. The Telemetry page has a lap rail on the left (`src/components/workspace/LapRail.tsx`: session selector, lap list, quick picks, collapsible; it replaced the header pickers, vroom-pnw.33). `CornerRail.tsx` there is the right-hand "Where the time goes" rail (every corner in track order with delta, gain/loss bar and cause direction; coach findings and corner answers under their corner; losses-only filter; collapsed by default below 1280 px, with a "Biggest first" sort; it replaced the Biggest losses row, vroom-pnw.34). The **Session tab** (next to Strips and Corners, `src/components/session/`, vroom-bi4.12) shows the session report for the lap rail's session: a lap-time chart, tyre temperature, pressure and brake temperature charts with working-window bands and in-car setting-change markers, and the event list with category filters. A click on a lap or an event sets `?lap`, `?ref` (the session's best lap) and `?at` (the event's distance); a session without traces (the Monza race) opens as `/?session=<id>`, the tab alone with a note that playback is not available. `?suggest` adds the experimental setup and driver-aid suggestions panel to the Session tab (`lib/setupSuggestions.ts`, `components/session/SuggestionsPanel.tsx`; spike vroom-k5s.2, write-up `docs/session-report/suggestions.md`). `?ui=one` shows the experimental UI-overhaul prototype (spike vroom-pnw.58, `src/components/oneapp/`, write-up `docs/ui-review/overhaul.md`): a scope line, a Lap view led by plain-language losses with Replay, and a Session view (`&scope=session`) with the session summary (`lib/sessionSummary.ts`).

**Screenshots for agents** (vroom-pnw.47; Claude in Chrome doesn't support WSL and terminal sessions have no browser pane, so Playwright is the browser). `npm run shots -- <path|url>... [--width 1600x900] [--out shots]` reuses a dev server on 5173 (set `SHOTS_PORT` to use another port) or starts Vite with the mock API and stops it afterwards, then prints the PNG paths (default folder `frontend/shots/`, git-ignored). It sets the WSL workarounds itself (`DBUS_SESSION_BUS_ADDRESS=disabled:`, locale `en-US`). The home page takes about a minute and a half on this machine, because the first canvas-2D draw (the uPlot strips) blocks the main thread once for 55-95 s under software WebGL: a Chromium/SwiftShader limit, reproducible on a blank page and not fixable from app code (vroom-8ps, accepted); the script waits for it. The 3D view has no URL, so reach it with the MCP server. `.mcp.json` registers `@playwright/mcp` (exact version, same env and locale through `frontend/scripts/playwright-mcp.json`) so a worker can click through the app; approve the project server once, and run `npx @playwright/mcp@0.0.85 install-browser chromium` once if the browser is missing (its Chromium build differs from the one `npm run shots` uses; `npx playwright install chromium` in `frontend/` installs that one). It writes `.playwright-mcp/` in the current folder (git-ignored). Neither runs in vitest or CI.

Run test, lint and build before calling frontend work done. Vite proxies `/api` to
`127.0.0.1:8765` for when the real backend exists.

## Rules that matter

- **Components talk to data only through the `Api` interface** (`src/api/client.ts`). Never
  import mock data directly. When the contract changes, update `types.ts`, the mock and its
  tests together.
- **UI stack:** TanStack Query for server data, Zustand for playback state, Radix UI for
  menus, popovers (annotation cards), sliders and toggles, uPlot for the strips, custom SVG for the classic map and
  scrubber, three.js (WebGL, lazy-loaded chunk) for the detailed track views (#33, #45, #39), CSS Modules with theme tokens as CSS variables (`src/theme.ts`). The theme is
  dark only and dense: 6 px spacing, 4 px radius, 12 px Inter.
- **No tracking-like words in frontend file or folder names** (`trackview`, `tracking`,
  `analytics`, `beacon`, `pixel`). Ad blockers block those module URLs in `npm run dev`, which
  leaves a white page.
- **Never commit a 3D car model**, its textures, a converted copy or anything derived from one. The repo is public and most downloadable models are game rips that cannot be redistributed (#102). Users bring their own through the 3D view's Car popover (kept in their browser only), or as a developer into the git-ignored `frontend/public/local-models/`; check `git status` before committing.
- **Dev-only files stay out of the build.** `frontend/public/` is copied into `dist/` by Vite, so `npm run build` removes `mock/`, `mockServiceWorker.js` and `local-models/` (the `stripDevOnlyPublicFiles` plugin in `vite.config.ts`). `npm run dev` still serves all three. Add any new mock-only or licence-restricted file to that list.
- **Never modify an LMU recording.** Copy it first, then open the copy read-only. LMU lives at
  `/mnt/d/Steam/steamapps/common/Le Mans Ultimate` (this is WSL).
- **LMU data facts** (details in `docs/lmu-duckdb-schema.md`):
  - "G Force Lat" is longitudinal and "G Force Long" is lateral.
  - GPS is LMU-local, not real-world, and float32 (about 0.4 m steps).
  - Recordings have no elevation channel, but LMU's shared memory has the world position (`y` is up, metres): see "Shared memory" in `docs/lmu-duckdb-schema.md` and `docs/track-views/elevation-shared-memory.md` (#94).
  - Shared memory has each wheel's terrain name at 100 Hz, and the car's orientation `mOri` (rows of the vehicle-to-world matrix; vehicle +x = left, +z = back). Tarmac to non-tarmac wheel crossings give the physical track edge (`decode.py survey`, `contacts`; #97).
  - Surface type 6 is the flat kerb (`RMBLFLAT`); 5 is the razor kerb but also drains and concrete (`COBL,DRAIN`, `CRETE`), so the recording's type-5 flag over-counts and type 6 must be counted too (#97). Per-wheel terrain names are in shared memory only (`docs/track-views/edge-survey.md`).
  - GPS is a fixed transform of the world position (verified on Spa): `x = lon·R·π/180·cos 60°`, `z = (lat − 60)·R·π/180`, R = 6371008.8 m.
  - An invalid lap has `Lap Time` = 0.
  - `CarSetup` is the setup at the start of the recording; a garage visit starts a new recording. In-car brake bias changes are recorded as `Brake Bias Rear` events (rear share).
  - Steering is −100..100 with + meaning right.
  - Grid channels: `g_lat` > 0 is a left turn and `g_long` > 0 is braking. The recordings have no orientation channel; the cockpit camera estimates it (`docs/track-views/cockpit-view.md`).
  - `Path Lateral` is metres from the track centreline, + meaning right of travel (10 Hz).
  - The recorder can't log yaw rate, slip or tyre load: config.json only takes names compiled into the exe (`docs/lmu-channels.md`). Shared memory has yaw rate (`mLocalRot_y`, + = right turn) and slip velocities, but LMU zeroes `mTireLoad`, `mGripFract` and the tyre forces there; `mSuspForce` is live (vroom-pnw.16).
  - Driver throttle is `Throttle Pos Unfiltered`; `Throttle Pos` is after the game's interventions (0 at every upshift).
- **The coach** (planned backend): the LLM only phrases facts computed in code. Every number
  it uses must appear in the facts it's given, and fixes never use metre distances.
- **The repo is public** (again, as of 2026-11-06; a public fork also holds a 2026-11-04
  snapshot): no absolute home paths, emails, API keys or the driver name in code, issues or
  commits, and only commit third-party assets whose licence allows redistribution. `.env` is
  git-ignored.
- **Game assets:** LMU track files are encrypted and the EULA forbids extracting them. 3D work
  is procedural, built from telemetry and public terrain data.

## Workflow

- **Work runs on the Dispatch Loop.** Start an issue with `/dl:dispatch <id>` from the main
  checkout: it opens a worktree on branch `dl/<id>` with a fresh session and the issue's contract.
  When the user says ship it, use `/dl:ship`. It runs the quality commands, opens the PR, merges
  and closes the issue. New ideas mid-task go in `bd q "<title>" -t task`; don't widen the current
  issue. Goals and order of work are in `docs/spec.md`.
- **Autopilot (agents develop this project on their own).** `/dl:autopilot start` runs a loop that
  dispatches ready issues from the epics in `.claude/dispatch-loop.json` → `autopilot.epic_order` with
  `dl-dispatch --auto`. Those workers follow `contracts/autopilot.md` from the Dispatch Loop plugin: an
  Opus reviewer and an Opus judge stand in for the user, and the worker ships itself or parks the issue
  with label `needs-human`. Parked issues are the user's queue (`/dl:standup` lists them first).
- **Branch off `main`** and open a PR; don't commit directly to `main`. Only commit or push
  when asked. Outside the loop, reference the Beads ID in the PR text.
- Exploration issues (label `spike`) end with a prototype in the app labelled
  "experimental", a write-up in `docs/track-views/<topic>.md`, and the user's keep / change /
  drop decision.

## Keeping this file current

Status goes in Beads, not here. Update this file **in the same PR** as any change that
makes it wrong:
- a phase change (e.g. `backend/` is created, the frontend switches to the real API);
- an agreed change to the order of work;
- a new top-level folder;
- new or changed commands;
- a new rule or convention;
- a newly verified LMU fact (put it in `docs/lmu-duckdb-schema.md` as well).

When you touch "Where things stand", update its "last checked" date. If you find this file
contradicting the code or Beads, fix it or say so.
