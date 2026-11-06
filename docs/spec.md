# vroom-vroom: product spec

Status: draft, 2026-11-07. Sources: the design agreed on 2026-11-03 (kept outside the repo), `CLAUDE.md`, and the Beads epics.
Work status lives in Beads (`bd ready --exclude-type epic`), not here. This file says what
we are building and why, and in what order.

## Purpose

A personal telemetry coach for **Le Mans Ultimate (LMU)**. It helps one driver find lap time by playing a lap against
a reference lap and having an LLM coach explain where and why time was lost. It is a single-user tool that runs on one
machine.

## Goals

1. **See the lap against a reference.** Import LMU's own `.duckdb` recordings, align laps by distance on a 1 m grid,
   and play a lap and its reference together: a map with both cars, input strips, a delta scrubber.
2. **Explain where time went, from facts.** Per-corner metrics (braking, minimum speed, throttle pickup, exit speed,
   coasting, consistency) are computed in code and are testable. The LLM coach only phrases those facts:
   - every number it uses must appear in the facts packet it was given (enforced by a guard, with one retry);
   - a fix uses a landmark, feel or own-lap cue, never a metre distance;
   - only `detected` or `confirmed` landmarks appear in coaching;
   - it says when the data is ambiguous and never invents physics the data doesn't show.
3. **Show the track as it really is.** Track views that go from the classic 2D map to a detailed 2D view and a 3D view
   (chase, cockpit, orbit, top cameras), built procedurally from telemetry, LMU shared-memory captures and public
   terrain data.
4. **Stay sim-agnostic in the data model.** LMU is the only sim supported, but the lap model and the API contract
   don't depend on LMU names or units, so another sim can be added later.
5. **Grow in stages** from post-session analysis to live voice coaching, conversation and setup advice. Each stage is
   built on the facts from the stage before it.

## Non-goals

- **Multi-user, accounts or cloud hosting.** It runs locally, for one driver; the backend serves `127.0.0.1` only.
- **Other sims, for now.** The model allows them; no importer is planned.
- **Extracting or shipping game assets.** LMU track files are encrypted and the EULA forbids extracting them. 3D work
  is procedural. No 3D car model, texture or anything derived from one is ever committed; users bring their own.
- **Modifying LMU data.** Recordings are copied and the copy is opened read-only. The setup engineer (v5) reads setups
  and never writes them.
- **An LLM that calculates.** It never computes numbers or reads raw telemetry, except the Corner deep dive, whose
  packet includes trace data.
- **A spending cap on LLM calls.** Every call's cost is logged and shown; there is no budget limit.
- **A light theme or a Settings page in v1.** The UI is dark-only and dense; configuration lives in files.
- **Other drivers' laps.** Importing laps from the internet is a "later" idea, with no stage yet.

## Milestones

Each milestone is a Beads epic, and its issues are its children. GitHub milestones and the project board are retired.

| Milestone | Epic | What it delivers |
|---|---|---|
| v1 – UI on mock data | `vroom-pnw` | Telemetry (home), Sessions and Tracks pages against an MSW mock API serving a real Spa recording. Annotations on map, strips and scrubber; the coach commands Analyze, Average and Corner, mocked. The API contract (`frontend/src/api/types.ts`) that the backend must match. Remaining work: the 2026-11-04 review bugs, keyboard access, refactors, error boundaries, and how mock recordings are stored and shipped. |
| Analysis features | `vroom-bi4` | New analysis on the mock, built contract-first: gear strip, strip picker, ABS/TC/slip, corner report card, biggest losses, where a lap was invalidated, setup diff, ideal lap; spikes on oversteer/understeer, extra recorder channels and a stint view. Each contract change is written into the matching v2 issue. Split out of v1 on 2026-11-07. |
| Track views | `vroom-ueg` | Detailed 2D (WebGL) and 3D track views behind one `TrackViewProps` interface: geometry contract (elevation, edges, transform), procedural low-poly track, split view of lap and reference. Spikes end with a prototype labelled "experimental", a write-up in `docs/track-views/`, and a keep / change / drop decision. |
| v2 – Real backend | `vroom-9ki` | Python package `racecoach` in `backend/` (uv, FastAPI, DuckDB, polars, Pydantic AI) on `127.0.0.1:8765`: LMU reader, distance fusion and 1 m resampling, store and importer, folder watcher, track maps and corner detection, per-corner metrics, the coach with its number guard, an HTTP API matching the contract, then switching the frontend to it. |
| v3 – Live coaching | `vroom-7cb` | A Windows agent reading LMU shared memory (reusing `tools/lmu-logger`), push-to-talk on a wheel button, local speech-to-text and text-to-speech, short timed cues between corners. |
| v4 – Conversation | `vroom-9ke` | Free-form follow-up questions to the coach, grounded in the same fact packets. Scope to be defined after v3. |
| v5 – Setup engineer | `vroom-k5s` | Read-only setup advice from telemetry, handling evidence and driver feedback, one or two changes at a time with reasoning. First step already in v1: the setup diff between a lap and its reference. Scope to be defined after v4. |

## Order of work

Agreed order:

1. **Track views** (`vroom-ueg`): detailed 2D first, then 3D.
2. **v1 – UI on mock data** (`vroom-pnw`): the remaining bugs, keyboard access, refactors and mock-data chores.
3. **Analysis features** (`vroom-bi4`): the new features and their spikes. v1 and Analysis features are both
   finished before the backend starts (decided 2026-11-07).
4. **v2 – Real backend** (`vroom-9ki`): its Tasks 1–13 in dependency order, from scaffold to the HTTP API.
5. **Switch the frontend to the real API** (the last v2 task), then v3, v4 and v5 in turn.

v3–v5 are not broken into issues yet. Each epic's acceptance criterion is to break it into issues once the stage
before it ships.

## Open questions

These are already spikes or decision issues in Beads; their outcome may change this spec.

- How real-recording mock JSON is kept now that the repo is public again: in git, Git LFS, or generated locally
  (`vroom-pnw.11`).
- Whether a procedural low-poly 3D track meets the 60 fps target and is recognisable (`vroom-ueg.2`).
- Whether oversteer and understeer can be estimated well enough to coach on (`vroom-pnw.15`), and whether LMU's
  recorder can log more channels (`vroom-pnw.16`).
- Which fuel, virtual energy and tyre channels LMU records, for a stint view (`vroom-pnw.26`).
