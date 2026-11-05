# Track edges and kerbs from telemetry (#36)

**Question:** can the asphalt width and the kerbs be rebuilt from what the car reports while driving, well enough to judge a racing line against the track ("did I use all the road?")? LMU track files are encrypted and the EULA forbids extracting them, so telemetry is the only source.

**Target:** edges look continuous and plausible at ~20 m zoom across Spa, with problem areas documented.

**Status:** spike, prototype in the app (PR #65): detailed 2D map, **Edges: Stand-in / Telemetry** toggle, labelled experimental. **Decision (2026-11-05): keep, as recommended below.**

## Data facts this relies on

Verified on the Spa recording of 2026-11-03 (see also `docs/lmu-duckdb-schema.md`):

- **`track_edge`** (10 Hz) is the distance from the centreline to the edge **on the side the car is on**, with that side's sign. It always has the same sign as `path_lateral`. So one lap only ever measures the side it is driving on.
- It is **interpolated at 10 Hz**, so where the car crosses the centreline the value sweeps through 0 between a negative and a positive width. Those samples are garbage.
- **Lap-to-lap agreement is good:** where two laps measured the same side at the same metre, they agree to a median of 3 cm.
- **The two sides differ:** half-widths range from 3.6 to 7.6 m, and left and right differ by up to ±4 m at the same metre. One side can't be mirrored onto the other.
- **Kerbs** come from `SurfaceTypes` value 5 (rumble strip), per wheel at 5 Hz. The mock carries it as a 0/1 `kerb` flag per metre. There is no lateral position for the kerb itself.

## What was built

- **`frontend/src/lib/trackEdges.ts`** (pure, unit-tested):
  - `edgeHalfWidths(laps, n)`: per lap, a sample counts only if its sign is steady within ±6 m (`FLIP_GUARD_M`) and the car is on track (|`path_lateral`| ≤ 15 m). Per metre and per side: the median over laps, then a ±3 m average over measured neighbours only, then linear interpolation across unmeasured gaps (wrapping at the line). Each metre is flagged measured or filled.
  - `kerbRuns(laps, n)`: the kerb flag on the side of `path_lateral`, merged across laps, gaps of ≤ 5 m joined, runs under 3 m dropped.
- **Scene** (`mapviews/detailed/scene.ts`), in Telemetry mode:
  - The edges are drawn from the measured half-widths along the centreline's normals, built from **the two compared laps** (the only laps the current `Api.compare` returns).
  - Kerbs are red/white strips 0.9 m wide (world units, so they scale with zoom), placed **just outside** the edge (see below).
  - The gain/loss band (Track style, #59) follows the measured edges exactly and only widens, by 0.5 m, where a car line goes past an edge. The Beside line keeps clear of the real edges.
- **Debug view only** (`npm run dev` or `?debug`): measured stretches of the edge get a faint tint, so filled stretches can be told apart.

## Results

Spa, lap 4 against lap 3 unless stated.

**Continuity (the target):** the largest change in half-width between neighbouring metres is **0.21 m left, 0.14 m right**. There are no steps or spikes; at 20 m zoom the edges read as smooth lines.

**Coverage**, the share of the lap where a side is measured rather than filled:

| Laps used | Left | Right |
|---|---|---|
| 3 + 4 (the compared pair, as in the app) | 52.4 % | 47.7 % |
| 1–4 (all flying laps) | 56.3 % | 53.4 % |
| 0–6 (including out-lap, in-lap and the invalid lap) | 67.4 % | 61.7 % |

With laps 1–4, the longest filled stretch is **456 m on the left** and **303 m on the right**. More laps help, but slowly: a driver on a good line keeps to the same side through each corner, so the other side is rarely measured.

**Racing lines against the edges:** 3.9 % of lap 4 (260 of 6620 measured metres) and 3.0 % of lap 3 lie outside the measured edges. That matches cars using kerbs and running wide on exits. In filled stretches it's 0 %, as expected: the side the car is on is almost always measured.

**Gain/loss band:** after fitting it to the edges, the band averages 10.72 m wide against 10.62 m between the edges (it was 11.58 m when it was built around the old stand-in edges). The remaining 0.1 m is the bulges where a car leaves the track.

**Kerbs:** 20 runs from laps 3 + 4; 8 left and 15 right from laps 1–4.

## Where kerbs sit

There is no kerb position in the data, so the side of the edge was inferred. Across laps 1–4, on every metre where the kerb flag is on, the car's centre is this far **inside** the reported edge:

| p5 | p25 | median | p75 | p95 |
|---|---|---|---|---|
| −0.56 m | 0.04 m | 0.44 m | 1.04 m | 1.81 m |

Off kerbs the median is 1.90 m, and the car's centre is rarely within 0.31 m of the edge (p5).

Taking the outer wheels as ~0.8 m from the car's centre (an assumption: roughly half a GT car's track width), the outer wheel is usually **0–1.4 m past** the reported edge while on a kerb. So `track_edge` most likely marks the **inner line of the kerbs** (the edge of the normal tarmac), and the kerbs lie mostly outside it. The prototype draws them there, with their inner side on the edge line.

## Known limits

- **Filled stretches are guesses.** Straight-line interpolation over up to 456 m can cut or bulge where the real edge curves, for example on the outside of a long corner the car never approaches. They're plausible, not measured.
- **Kerb ends are approximate.** The surface flag is 5 Hz per wheel; at 180 km/h that is 10 m between samples, so each end can be off by up to about one sample.
- **Kerbs only show where a wheel touched them.** A kerb used partly looks short, and one never touched is missing.
- **Kerb width (0.9 m) is a guess**, and their side of the edge is inferred, not measured.
- **Pit entry and exit:** samples with |`path_lateral`| > 15 m are dropped, so the pit lane itself never feeds the edges. Out-laps and in-laps used as a comparison add their on-track parts only. Not separately checked on screen.
- **Run-off:** the data says nothing about run-off areas, gravel or grass widths. Only the asphalt edge is known.
- **Per-comparison:** the edges are rebuilt from whichever two laps are compared, so they can shift slightly between comparisons.

## In the app

User check, 2026-11-05:
- The first version drew measured edge stretches nearly white (a colour mix done in linear space). Fixed: plain edge colour normally, a faint tint in debug view only.
- The gain/loss band was wider than the track at La Source (it was still built around the stand-in edges). Fixed as described above.
- Kerbs first sat inside the edge with a visible gap; after the wheel-position check above they sit flush outside it.
- "Looks good for now."

## Recommendation

**Keep**, and build it properly:
- **Compute edges and kerbs once per track from all laps**, in the backend, and serve them as track geometry (#38, #41). That's more coverage (about 56 % per side from 4 flying laps, more from every session added) and edges that don't change between comparisons.
- **Show filled stretches honestly:** keep them visually identical in normal view, but expose measured coverage to the backend so later work (3D, coach facts about "using all the road") can skip unmeasured stretches.
- **Kerbs:** cluster hits across all laps; take the ends from where hits start and stop, widened by one 5 Hz sample. If per-wheel surface flags plus the car's track width are available in the backend, estimate the kerb's lateral extent instead of assuming 0.9 m.
- **Keep the Stand-in toggle** until the backend serves geometry, as a fallback for tracks with too little data.

## Screenshots

_To add: Telemetry edges at La Source and the Bus Stop at ~20 m, a long filled stretch, a kerb at a corner exit, and the Track gain/loss band fitted to the edges (`img/edges-*.png`)._

## Decision

**Keep** (2026-11-05), recorded on #36. The build work goes into #38 (TrackGeometry contract and mock: edges and kerbs computed from all laps, with measured coverage) and #41 (the same computation in the backend). The Stand-in toggle stays until the backend serves geometry.
