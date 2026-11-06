# vroom-vroom: AI sim racing engineer

A personal telemetry coach for **Le Mans Ultimate (LMU)**. It imports LMU's own `.duckdb`
recordings, aligns laps on a 1 m distance grid, plays a lap against a reference lap, and has
an LLM coach annotate where time was lost. The data model is meant to work for any sim, not
just LMU. Stages: **v1** UI on mock data (current), **v2** real backend, **v3** live voice coaching
through a Windows agent, **v4** conversation, **v5** setup engineer.

## Where things stand

**The GitHub board is the source of truth for status:** repo `marlou-lopez/vroom-vroom`
(public), board https://github.com/users/marlou-lopez/projects/7. Before starting, check open
issues, what's In Progress, and milestones `v1`–`v5` and `Track views`. Each issue stands on its
own and lists its dependencies. Don't rely on this file for progress.

This section only records facts that change rarely (last checked 2026-11-06):
- **Phase:** the frontend runs on a mock API serving one real Spa recording. The backend
  hasn't been started, and there's no `backend/` directory yet.
- **Agreed order:** first the **Track views** milestone (detailed 2D, then 3D), then the backend
  (milestone `v2 – Real backend`, Tasks 1–13), then switching the frontend to the real API.
- The design spec, the v1 plan and handover notes live outside the repo, in
  `~/.claude/plans/superpowers/ai-sim-racing-engineer/`. The issues already copy the details
  that matter.

## Layout

| Path | What |
|---|---|
| `frontend/` | React 18 + TypeScript (~5.9) + Vite app |
| `frontend/src/api/types.ts`, `client.ts` | **The API contract.** The future backend must match it |
| `frontend/src/api/mock/` | MSW mock API built on the real Spa laps (`public/mock/spa-2026-11-03.json`) |
| `frontend/src/pages/` | Telemetry (home, `/`), Sessions, Tracks |
| `frontend/src/lib/` | Pure logic: playback, track map projection, strips, formatting, car attitude estimate for the cockpit camera (unit-tested) |
| `frontend/src/state/` | Zustand playback store, data and coach hooks |
| `frontend/src/components/mapviews/` | Track panel views (classic 2D SVG, detailed 2D on WebGL, experimental 3D ribbon in `ribbon/`, with chase, cockpit, orbit and top cameras) behind one `TrackViewProps` interface; `shared/` holds what the WebGL views have in common (badge layer, ring buffer, storage helpers) |
| `docs/lmu-duckdb-schema.md` | **Verified LMU recording facts**: they override any assumption in plans or issues |
| `docs/track-views/` | Spike write-ups and decisions for the Track views milestone (e.g. `edge-survey.md`, `elevation-shared-memory.md`) |
| `tools/extract-laps.mjs` | Turns an LMU `.duckdb` into the mock JSON (needs `npm i @duckdb/node-api`) |
| `tools/lmu-logger/` | Windows-only Python logger that records LMU's shared memory to `.lmucap` files (player-only by default), plus a reader, a header parser (`layout.py`, reads the layout from your own LMU install: no struct copies, licence) and `decode.py` (`layout`, `player`, `track`, `survey`) (#94, #97). Captures stay out of git |
| `.claude/skills/vroom-issue/` | Project skill for filing GitHub issues |

The planned backend is a Python package `racecoach` in `backend/` (uv, FastAPI, DuckDB,
polars, Pydantic AI), serving `127.0.0.1:8765`.

## Commands (run in `frontend/`)

```bash
npm run dev     # http://localhost:5173; VITE_API=mock in .env.development starts MSW
npm run test    # vitest
npm run test:coverage  # vitest with v8 coverage, report in coverage/
npm run lint    # oxlint
npm run build   # tsc -b && vite build
```

Tests named `*.test.ts` run in node and `*.test.tsx` run in jsdom (setup in `src/test/setupDom.ts`; MSW mock server helpers in `src/test/mockServer.tsx`).

CI (`.github/workflows/ci.yml`) runs lint, test and build on every PR and push to `main`.

The detailed 2D and 3D track views show their frame-rate HUD, benchmark and GPU context-loss test (and the 2D one its line-source selector) only in `npm run dev` or with `?debug` in the URL; `?debug=0` hides them in dev to preview the production view.

Run test, lint and build before calling frontend work done. Vite proxies `/api` to
`127.0.0.1:8765` for when the real backend exists.

## Rules that matter

- **Components talk to data only through the `Api` interface** (`src/api/client.ts`). Never
  import mock data directly. When the contract changes, update `types.ts`, the mock and its
  tests together.
- **UI stack:** TanStack Query for server data, Zustand for playback state, Radix UI for
  menus, hover cards, sliders and toggles, uPlot for the strips, custom SVG for the classic map and
  scrubber, three.js (WebGL, lazy-loaded chunk) for the detailed track views (#33, #45, #39), CSS Modules with theme tokens as CSS variables (`src/theme.ts`). The theme is
  dark only and dense: 6 px spacing, 4 px radius, 12 px Inter.
- **No tracking-like words in frontend file or folder names** (`trackview`, `tracking`,
  `analytics`, `beacon`, `pixel`). Ad blockers block those module URLs in `npm run dev`, which
  leaves a white page.
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
  - Steering is −100..100 with + meaning right.
  - Grid channels: `g_lat` > 0 is a left turn and `g_long` > 0 is braking. The recordings have no orientation channel; the cockpit camera estimates it (`docs/track-views/cockpit-view.md`).
  - `Path Lateral` is metres from the track centreline, + meaning right of travel (10 Hz).
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

- **File issues with the `vroom-issue` skill.** It applies the labels (type and area),
  milestone, Status and Priority on the board. Reference issues in commits and PRs
  (`Fixes #N`).
- **Branch off `main`** and open a PR; don't commit directly to `main`. Only commit or push
  when asked.
- Exploration issues (label `spike`) end with a prototype in the app labelled
  "experimental", a write-up in `docs/track-views/<topic>.md`, and the user's keep / change /
  drop decision.

## Keeping this file current

Status goes on the board, not here. Update this file **in the same PR** as any change that
makes it wrong:
- a phase change (e.g. `backend/` is created, the frontend switches to the real API);
- an agreed change to the order of work;
- a new top-level folder;
- new or changed commands;
- a new rule or convention;
- a newly verified LMU fact (put it in `docs/lmu-duckdb-schema.md` as well).

When you touch "Where things stand", update its "last checked" date. If you find this file
contradicting the code or the board, fix it or say so.
