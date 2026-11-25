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

This section only records facts that change rarely (last checked 2026-11-25):
- **Phase:** the frontend runs on a mock API serving real Spa and Monza recordings. The backend
  is scaffolded (`backend/`, vroom-9ki.1: uv project, LMU rate, probe and fixture tools); the
  telemetry model, reader and API are not built yet.
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
| `frontend/src/pages/` | Telemetry (home, `/`: the Lap and Session views), Sessions (`/sessions`, the Track and car view, opened by the scope line's first crumb with `?session=<id>`: trend, cards and session list, then `components/TrackMapSection.tsx` with the labelled map and the full corner table; the landmark editor and re-calibration sit behind an "Advanced" control, closed by default, remembered in localStorage by `lib/tracksAdvanced.ts`, vroom-xg2, vroom-pnw.65). There is no Tracks route and no header nav: the scope line navigates. The Stint view in the Session view opens with a one-sentence summary (`stintSentence` in `lib/stint.ts`) and keeps the fit formula behind "How is this worked out" |
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
| `tools/tune-thresholds.py` | Reruns the backend analysis thresholds (steering-correction smoothing, prominence and floor, corner lead-in, kerb filters) on your own recordings and prints Markdown tables: `cd backend && uv run python -I ../tools/tune-thresholds.py <recording.duckdb>...` (copies first). Verdicts: `docs/analysis-tuning.md` (vroom-9ki.15) |
| `tools/aerial-edges/` | Edges and kerbs of a track from open aerial imagery (experimental, vroom-ueg.8): `uv run --no-project --with numpy,scipy,pyproj,pillow python -I run.py spa` in that folder; one adapter per imagery source in `sources/`, one config per track in `tracks/`. `cache/` (imagery) and check pictures are never committed; the app's copy is `public/mock/spa-aerial-2023.json` (vectors with their attribution), served as `TrackGeometry.aerial` and drawn by the Close-up view's Edges option "Aerial (experimental)". Write-up: `docs/track-views/aerial-imagery.md` |
| `backend/` | Python package `racecoach` (uv, typer CLI). `racecoach serve` runs the HTTP API (`racecoach.api`, FastAPI, vroom-9ki.13: `routes.py` has one route per `Api` method in `frontend/src/api/client.ts`, `views.py` the JSON shapes, the compare maths and the stitched ideal lap, `errors.py` the `{code, message}` bodies; the lifespan starts the folder watcher on its own store cursor when `lmu_telemetry_dir` exists and serves `frontend/dist` when built; every request gets its own DuckDB cursor, `AppStore.view()`). `GET /tracks/{id}/geometry` (vroom-9ki.16) is built by `racecoach.geometry` (port of the frontend's `elevation.ts`, `trackSurvey.ts`, `aerialEdges.ts`): the centreline is the track's reference lap's line, and elevation, survey and aerial edges come from JSON files in `<track_data_dir>/<track_id>/{elevation,survey,aerial}.json` (`RACECOACH_TRACK_DATA_DIR`, default `<data_dir>/track-data`; same shapes as `frontend/public/mock/spa-{elevation,survey,aerial}-*.json`; a missing file gives null for that part). Not served yet: car sizes (`car_dims` is null), the garage setup (`/setup` returns no entries) and the session report's events and windows (`/report` has the per-lap series only); the coach does not take an `ideal:` reference yet. `racecoach rates apply <config.json>` sets the six lap-grid channels to 50 Hz in LMU's recorder config (with a timestamped backup); `racecoach probe <file.duckdb>` prints a recording's layout as Markdown; `racecoach fixture <src> <dst> --laps 3` trims a recording into `tests/fixtures/spa_720s.duckdb` (under 5 MB: FLOAT channels are rounded (2 decimals; 4 for metre channels and brake force), but Lap Dist, G, GPS, GPS Time, DOUBLE columns and events are exact; `DriverName` and `SteamID` are blanked; the one fixture committed, `.gitignore` allows `backend/tests/fixtures/*.duckdb`). Recordings are always copied to a temp folder first (`lmu/db.py`); `racecoach.lmu.reader.read_lmu_duckdb(path)` turns a recording into a `RawSession` (internal names and units, steering normalised to −1..1, G channels un-swapped, throttle from the unfiltered pedal; vroom-9ki.3); `racecoach.lmu.laps.build_laps(raw)` splits it into `(LapMeta, LapTrace)` pairs on the 1 m grid, using `telemetry/distance.py` (`fuse_distance`) and `telemetry/resample.py` (`to_distance_grid`); vroom-9ki.4); `racecoach.settings.Settings` (`RACECOACH_*` env and dotenv, `backend/.env.example`; `llm_provider` openai by default with `gpt-6.1-terra` / `gpt-6-luna`, anthropic has defaults too, gemini and ollama need `RACECOACH_LLM_STRONG` and `RACECOACH_LLM_FAST`; `llm_base_url` for OpenAI-compatible hosts), `racecoach.llm` (`make_model(settings, tier)` on Pydantic AI, `LlmError` codes `missing_api_key` / `network` / `provider` via `to_llm_error`, `cost_usd(model_id, usage)` via genai-prices, None for local or unknown; Anthropic system prompt cached; vroom-9ki.11), `racecoach.store.AppStore` (DuckDB `app.duckdb` metadata plus one Parquet per lap in `traces/`; `reference_for(track_id, car_id)` is the pinned lap, else the fastest flying lap whose `valid_override` or `valid` is true), `racecoach.stint` (per-lap fuel, virtual energy, tyre, brake and weather stats computed at import and stored in `lap_stint_stats`; `session_stints(store, session_id)` is `GET /sessions/{id}/stints`, split after each in lap, each stint also carries `falloff` and `falloff_fuel_corrected`, a port of `lib/stint.ts` with the per-class `fuel_effect` constant in `config/cars.yaml` (null for a class without one), and `stint_facts` gives the coach both slopes and the assumption; vroom-9ki.20; vroom-9ki.18; recording copies now include LMU's `.wal`, which holds the last rows) and `racecoach.importer.import_file` (sha1, skip if known, copy to `raw/<sha1>.duckdb`, read the copy, one transaction; vroom-9ki.5); `racecoach.watcher` (`is_finished`, `scan_once`, `watch_forever`: imports finished recordings from `lmu_telemetry_dir`, polling because /mnt/d has no inotify; vroom-9ki.6), `racecoach.analysis.corners.detect_corners(ref)` finds corners on a reference lap, and `racecoach.tracks` holds `TrackMap`/`Corner`/`Landmark`, `load_map`/`save_map` (YAML in the repo's `tracks/<track_id>.yaml`, the Spa seed with `approx` corners), `draft_map` (T1..Tn), `calibrate` and `map_for` (vroom-9ki.7); `racecoach.analysis.landmarks` has `detect_kerbs(laps, map)` (kerb hits on ≥ 50 % of laps, clustered within 10 m, classed entry/apex/exit against the corner), `usable_landmarks`, `describe_position(pos_m, landmarks)` ("at / just before / shortly after the <label>", None beyond 40 m, never metres) and `own_lap_cue` ("where you braked on lap 7" within 3 m; vroom-9ki.8); `racecoach.analysis.delta` (`delta_time`, corner walks across the start line), `.metrics` (`corner_side`: the contract's per-side corner metrics plus release point, trail-release rate, full-throttle point, gear at apex, balance ratio), `.balance` (port of `carBalance.ts`: fit, trace, runs, `corner_understeer`) and `.facts` (`corner_facts`, `lap_facts`: entry/mid/exit phase losses, flat corners without braking metrics, landmark cues, corners sorted by loss, straights that add up to the lap delta; vroom-9ki.9), `.consistency` (`session_consistency`: lap mean/sd, best, theoretical best from sectors and from segments, per-corner spread sorted by sd, `NotEnoughLaps` under 2 valid flying laps; `ideal_lap(laps, map, scope)` = `IdealLap`, segments from `map_segments`, `NoValidLaps`; `FocusItem` and `evaluate_focus`: corner's mean time against the baseline, improved at ≤ −0.05 s, not at ≥ +0.05 s, else or under 2 laps None; vroom-9ki.10; `racecoach.coach` (the Coach, vroom-9ki.12: `packet.build_packet(store, command, lap_id, ref_lap_id, corner_id, tracks_dir=…)` builds packet set v3 from the analysis modules plus `analysis/aids.py` (ABS/TC seconds, lock-up, wheelspin, rev limiter, kerb) and raises `CoachError` (`not_enough_laps`, `no_reference`, `unknown_lap`, `unknown_corner`, `no_trace`, `nothing_to_coach`) before any LLM call; `guard` is the number guard (per-finding `allowed_numbers`, metre cues, lint, hedges); `service.run_coach(store, settings, command, …, model=None)` runs a Pydantic AI agent whose output validator retries once, then keeps prose problems as `warnings` and raises `invalid_output` for structural ones; prompts in `coach/prompts/` (`persona.md`, one per command, `NOTICE`), driver profile in `config/profile.yaml`; results in `AppStore.save_coach_result` / `latest_coach_results` / `set_finding_reviewed`, calls in `llm_calls`, analyze saves a focus item; the `ideal:` reference is not supported yet)) |
| `config/cars.yaml` | Maps LMU entry (livery) names to a `car_id` and gives a per-car `steering_range_deg` fallback, used by the backend reader, and the `fuel_effect` constant per car class |
| `docs/spec.md` | Product spec: goals, non-goals, milestones as Beads epics, order of work |
| `.claude/dispatch-loop.json` | Dispatch Loop config: the quality commands `/dl:ship` runs |

The backend is a Python package `racecoach` in `backend/` (uv, FastAPI, DuckDB,
polars, Pydantic AI planned), to serve `127.0.0.1:8765`.

## Backend commands (run in `backend/`)

```bash
uv run pytest && uv run ruff check && uv run pyright   # the backend's quality gate (CI job `backend`)
uv run racecoach --help
```

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

The detailed 2D and 3D track views show their frame-rate HUD, benchmark and GPU context-loss test (and the 2D one its line-source selector) only in `npm run dev` or with `?debug` in the URL; `?debug=0` hides them in dev to preview the production view. The Balance strip (Strips menu), understeer marks on the steering strip and the understeer tint on the classic map are on by default and read the API's `lap_balance` and runs (vroom-bi4.6; the client no longer estimates). `?balance` adds the experimental oversteer marks (the contract's `lap_oversteer_runs`, high precision but low recall). The app is the one app (spike vroom-pnw.58, default since vroom-pnw.64, `docs/ui-review/overhaul.md`, direction B); the `?ui=one` flag, the lap rail, Analysis bar, corner rail, inputs tabs, Corners tab, Session tab, Engineer line and the Sessions page's lower half are gone, and a stored `vroom.uiMode` is ignored. `lib/plainCorner.ts` serves the Lap view. `?mirror=0` turns off the 3D cockpit's live rear-view mirror (a second render pass; the glass then shows a still picture), to measure its cost. The Telemetry page (`src/pages/TelemetryPage.tsx`) renders the components in `src/components/oneapp/` and has two scopes. The **Lap view** (`/`): a scope line (lap select with each lap's gap to the session best, ‹ › buttons and ↑/↓ to step timed laps, `lib/lapStep.ts`; the Session view has "Back to the lap"), a story column (vroom-pnw.60, `lib/lapStory.ts`) that pins the lap and gap sentence while the three loss cards scroll (sentence, the coach's fix or a computed tip never repeated across cards, Replay), on an invalid lap the head also says where it was most likely invalidated (`lib/invalidLap.ts`, from the first wheels-off stretch; a click or the red cross on the classic 2D map and the scrubber seeks there, vroom-ake), then Ask the coach, "Every corner · N" and a "⋯" menu (Pin as reference, Mark lap valid or invalid via `usePatchLap`, Key, Hide notes, Ask again, Average, coach cost; the key's rows are `oneapp/Legend.tsx`); the page keeps the scope line, story and map mounted while the next lap loads and the map's issue numbers follow the story's ranking; the replay stage (vroom-pnw.63) has no inputs tabs or panel borders: strips are always on, the Graphs / Wheel & pedals switch, zoom and Choose strips sit in one "Strips ▾" menu (`DetailedStrips` `stage` prop, `StripMenu`), playback speeds in a menu next to Play (`Transport` `compact`), and the map sits beside the strips down to 900 px. The **Session view** (`?scope=session`, also `?session=<id>` without a lap, so a session without traces opens there, with a note that playback is not available; vroom-pnw.62, vroom-bi4.12): the session summary (`lib/sessionSummary.ts`), the session report from `src/components/session/` (lap-time chart, tyre temperature, pressure and brake temperature charts with working-window bands and in-car setting-change markers, the event list with category filters, folded past 5), the lap table with the best possible lap breakdown, and the race run; a lap or event sets `?lap`, `?ref` (the session's best lap) and `?at` (the event's distance) and opens the Lap view. The Sessions page (`/sessions`) is the track-and-car view: trend, cards and the session list, whose date opens that session's Session view. `?suggest` adds the experimental setup and driver-aid suggestions panel to the Session view (`lib/setupSuggestions.ts`, `components/session/SuggestionsPanel.tsx`; spike vroom-k5s.2, write-up `docs/session-report/suggestions.md`).

**Screenshots for agents** (vroom-pnw.47; Claude in Chrome doesn't support WSL and terminal sessions have no browser pane, so Playwright is the browser). `npm run shots -- <path|url>... [--width 1600x900] [--out shots] [--any-server]` reuses the dev server on 5173 only if it serves this checkout's `frontend/` folder (a dev-only Vite plugin, `frontend/vite-dev-root.ts`, answers `GET /__vroom-root` with the folder; it is not in `npm run build`; vroom-pnw.67). Otherwise, e.g. another worktree's Vite holds 5173, it starts its own Vite with the mock API on a free port and stops it afterwards (it prints which server it uses). `SHOTS_PORT` names a server explicitly: it must serve this folder too, or the script refuses, unless `--any-server` is given. It then prints the PNG paths (default folder `frontend/shots/`, git-ignored). It sets the WSL workarounds itself (`DBUS_SESSION_BUS_ADDRESS=disabled:`, locale `en-US`). The home page takes about a minute and a half on this machine, because the first canvas-2D draw (the uPlot strips) blocks the main thread once for 55-95 s under software WebGL: a Chromium/SwiftShader limit, reproducible on a blank page and not fixable from app code (vroom-8ps, accepted); the script waits for it. The 3D view has no URL, so reach it with the MCP server. `.mcp.json` registers `@playwright/mcp` (exact version, same env and locale through `frontend/scripts/playwright-mcp.json`) so a worker can click through the app (with several worktrees open, 5173 is often another checkout's server: start your own with `npm run dev -- --port <free port>` and navigate to that port, and check `curl localhost:<port>/__vroom-root` prints your own `frontend/` path); approve the project server once, and run `npx @playwright/mcp@0.0.85 install-browser chromium` once if the browser is missing (its Chromium build differs from the one `npm run shots` uses; `npx playwright install chromium` in `frontend/` installs that one). It writes `.playwright-mcp/` in the current folder (git-ignored). Neither runs in vitest or CI.

Run test, lint and build before calling frontend work done. Vite proxies `/api` to
`127.0.0.1:8765` for when the real backend exists.

## Rules that matter

- **Components talk to data only through the `Api` interface** (`src/api/client.ts`). Never
  import mock data directly. When the contract changes, update `types.ts`, the mock and its
  tests together.
- **UI stack:** TanStack Query for server data, Zustand for playback state, Radix UI for
  menus, popovers (annotation cards), sliders and toggles, uPlot for the strips, custom SVG for the classic map and
  scrubber, three.js (WebGL, lazy-loaded chunk) for the detailed track views (#33, #45, #39), CSS Modules with theme tokens as CSS variables (`src/theme.ts`). The theme is
  dark only and dense (vroom-pnw.66, `theme.ts`): 13 px prose, 12 px floor outside the stage (`--font-size-small`), 11 px in the stage (`--font-size-stage`: strips, transport, wheels, map views; `legibilityFloor.test.ts`), 15/20 px sentence-case titles, 8 px spacing, 6 px radius, 28 px controls. Regions are tones (`--color-surface`, `--color-surface2`), not 1 px boxes; cyan is only your trace and the primary action.
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
