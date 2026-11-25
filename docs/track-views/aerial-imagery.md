# Track edges and kerbs from open aerial imagery (vroom-ueg.8)

**Question:** can open aerial imagery give both edges and the kerbs of a whole track, accurately enough to replace or fill the
shared-memory survey (`edge-survey.md`), with a tool that is easy to run again for the next track?

**Answer:** yes for edges on Spa: 98 to 99.5 % of the lap on both sides, a median of 0.18 m (left) and 0.14 m (right) from the
wheel contacts, without driving a survey. Kerbs are found (no false run against the survey on Spa) but their ends miss the 1 m
target. Monza works with known local errors.

**Status:** experimental. In the app: View options, Track edges, **Aerial (experimental)** in the Close-up view (Spa mock only).
The 3D view follows that remembered choice when it is opened. The imagery credit is shown while it is drawn. On Spa,
metres without a seen line fall back to the survey's LMU width, so the drawn picture is not survey-free. Tool and steps for
the next track: `tools/aerial-edges/README.md`.

## Method

1. **Centreline and rough widths** from recordings: car position + `Path Lateral`, median over flying laps; the recorded track
   edge gives a half-width on the side the car was on. No shared-memory capture is needed.
2. **Coarse fit** of that line to the OSM `highway=raceway` ways: trimmed ICP of a similarity (scale, rotation, shift; no
   mirroring), several start rotations. The metric frame is a transverse Mercator at the track, declared with `+datum=WGS84`.
   With only `+ellps` PROJ skips the national datum shift and Spa's image lands about 110 m away.
3. **Straighten the image** along the lap: one row per metre (0.25 m for kerbs), columns every 0.1 m out to 18 m, per side.
4. **Edge**: a painted line scores by brightness over the asphalt on its inner side, minus that asphalt's roughness. Dynamic
   programming picks the smooth path with the best score near the recorded half-width (sigma 3 m). The edge is the line's outer
   side: its centre plus 0.1 m. Metres without a visible line are left out.
5. **Refine** the similarity so that the painted lines meet the recorded half-widths, with a constant width difference as a fifth
   unknown (0.23 m at Spa, 0.08 m at Monza). Robust least squares, four rounds. No warp: after the fit LMU's track and the photo
   agree as rigid bodies.
6. **Kerbs**: in a 0.7 m band outside the edge, red minus green along the track must swing with a period of 0.8 to 8 m
   (autocorrelation that passes through anti-phase first; Spa's stripe pairs are about 5 m, not the 1 m the issue expected).
   Solid painted run-off has no period. Ends come from where the warm colour (red minus blue) starts and stops; width from how
   far out the stripe swing reaches.

Classic image processing was enough; no learned model was tried.

## Numbers

Alignment (LMU world x/z to local east/north):

| | Spa | Monza |
|---|---|---|
| Imagery | SPW 2023 summer, 25 cm | AGEA 2024, 42 cm tiles |
| Coarse: scale, rotation | 1.0004, -2.31 deg | 1.0004, -0.21 deg |
| Coarse: distance to OSM, median / p90 | 0.60 / 1.38 m | 0.50 / 1.10 m |
| Refined: scale, rotation | 0.9999, -2.285 deg | 1.0001, -0.199 deg |
| Refined: moved from coarse | 0.25 m | 0.14 m |
| Refined: residual to the recorded widths, median / p90 | 0.13 / 0.66 m | 0.12 / 0.41 m |

Spa edges against the survey's wheel contacts (the app's outlier rule). The survey is not used in the fit:

| | Left | Right |
|---|---|---|
| Coverage (metres with a seen line) | 98.3 % | 99.5 % |
| Survey metres compared | 1,845 of 1,871 | 1,970 of 1,970 |
| Absolute error, median / p90 | 0.182 / 0.422 m | 0.139 / 0.328 m |
| Bias (+ = imagery wider) | -0.18 m | -0.12 m |
| Share under 0.3 m | 75 % | 87 % |

- **Target met** (median under 0.3 m). The recorded widths alone, interpolated, are 0.36 and 0.58 m off at the median there.
- Much of the error is a constant: contacts lie 0.1 to 0.2 m outside the line's outer side. Either LMU's tarmac goes on a little
  beyond the paint, or the survey's assumed half-track (0.85 m) is off. It was not tuned away, since the survey is the grader.
- **Upper bound**: a similarity fitted on the contacts themselves gave 0.14 / 0.12 m median and p90 0.31 m (one diagnostic run, with
  a narrower prior), so fitting on recordings alone costs a few centimetres.
- **Tuning caveat**: the prior's sigma was compared at 1, 2 and 3 m on Spa and 3 m kept for coverage; at 1 m coverage is 91 / 89 %
  and the medians are the same (0.181 / 0.129 m). The kerb thresholds were set by looking at Spa, so the Spa kerb counts are not a
  blind test. Monza is the only track the settings had not seen, and it did worse.

Spa kerbs against the survey's kerb runs (wheel hits):

| | |
|---|---|
| Survey runs (5 m or longer) | 65 |
| Matched | 36 |
| Missed | 29: 27 without any stripe swing beside the line in the image, 2 with a partial one (12 % and 24 % of the run) |
| False runs | 0 of 47 imagery runs (each overlaps a survey run) |
| Painted run-off | 16 solid coloured stretches, counted apart, none taken as a kerb |
| Start error | median +1.8 m, median absolute 1.9 m, p90 16 m, 14 % within 1 m |
| End error | median -1.5 m, median absolute 2.0 m, p90 41 m, 25 % within 1 m |
| Start, corrected for the wheel | median +0.56 m, median absolute 0.76 m, 53 % within 1 m |
| End, corrected for the wheel | median -0.26 m, median absolute 1.89 m, 36 % within 1 m |

- **Target (within 1 m) not met.** A survey hit sits at the car's centre although a wheel 1.24 m ahead or behind made it, so a
  survey run is that much too long at each end; the corrected rows take that out. The correction was chosen after seeing the raw
  bias. The large p90 has another cause: survey runs join hits up to 10 m apart, so two painted kerbs become one run, and they
  hold only what wheels touched.
- **Missed runs**: 12 of the 29 are LMU kerb terrain on the left at Blanchimont (5,600 to 6,200 m), where the photo shows plain
  grass or run-off. Whether LMU shows a painted kerb there needs a look in the game. "No stripe swing" is judged by the
  detector's own signal, so it cannot reveal a dirty kerb that the detector fails to see.
- By eye on Spa's check pictures: short gaps where a kerb is faded green or in shadow (Les Combes 2, Bruxelles, Pouhon), and
  widths too large at La Source, the Bus Stop and at the start of the pit straight, where stripes run into paint.

Monza (no survey to grade against): coverage 96.5 % left and 98.8 % right, edges a median of 0.18 m (left) and 0.37 m (right) from
the recorded widths, 25 kerb runs. Five of its 17 check pictures were looked at. Wrong there: at the first chicane both edges cut
across the escape road instead of following the line, partly marked as seen; a false kerb on the bridge over the track (about
3,580 m); red, white and green kerbs break into pieces and come out too wide, and some apex kerbs are missed. So Monza is not
served in the app.

## Sources and licences per LMU track

Only Spa and Monza services were used. Le Mans' service was listed but no image was fetched. The rest comes from catalogue pages
and searches, to check before writing an adapter. The track list is as of November 2026 (two US tracks not yet announced).

| Track | Source | Resolution | Licence |
|---|---|---|---|
| Spa | SPW Orthophotos 2023 Été | 25 cm | Data CC BY 4.0; the viewing service has its own terms, see below |
| Monza | AGEA 2024, open tiles; 20 cm download | 42 cm; 20 cm | CC BY 4.0 according to press on AGEA's legal notes (Aug 2026); the tile service itself names no licence |
| Imola | AGEA 2023, same portal | about 42 cm; 20 cm | as Monza |
| Le Mans | IGN BD ORTHO (`data.geopf.fr`) | 20 cm | Etalab 2.0 |
| Paul Ricard | IGN BD ORTHO | 20 cm | Etalab 2.0 |
| Portimão | DGT Ortofotos 2018 (a 2025 edition is listed too) | 25 cm | CC BY 4.0, credit the Direção-Geral do Território. OrtoSat 2023 is Airbus data and not open |
| Barcelona | IGN Spain PNOA | 25 cm or better; year unverified | CC BY 4.0 (scne.es) |
| Silverstone | Environment Agency vertical aerial photography | 10 to 50 cm | OGL; coverage of Silverstone unverified |
| Interlagos | GeoSampa 2020 | 10 to 20 cm | No licence named in the metadata: not usable until clarified |
| COTA, Sebring, Daytona, Laguna Seca, Road Atlanta, Long Beach | USDA NAIP | about 60 cm | Public domain; probably too coarse for kerb stripes |
| Bahrain, Lusail, Fuji | none found | | |

- **SPW viewing service** (terms v1.1, 2016): free, no disproportionate use, the source stays mentioned, the served data is not
  altered, and whoever copies data from the service follows the data's licence. The tool fetches about 80 tiles once, half a second
  apart. Reading that use as covered by CC BY 4.0 is this spike's interpretation. The strictly clean route is the CC BY download,
  but the Liège file is 49.8 GB and the server ignores range requests, so one tile cannot be pulled from it.
- **AGEA's 20 cm download** asks for an email address and a captcha, so it is not automated. The tile service needs neither.
- **In git:** `spa-aerial-2023.json` (262 KB): coordinates of edges and kerbs with the attribution. CC BY allows this with credit
  and a note of the change. No imagery, tiles or rendered pictures are committed; `tools/aerial-edges/cache/` is git-ignored. OSM
  serves for the alignment only (none of its coordinates are in the file). The JSON sits in `public/mock/`, which
  `stripDevOnlyPublicFiles` already removes from builds.
- This is not legal advice: the user should be happy with the SPW and AGEA readings before relying on them.

## Risks

- **Kerbs and paint change**: the photo's date is not the date of LMU's scan (the Spa photo is from 2023).
- **Trees, shadows, bridges and parked cars** hide the line. Those metres are left out, but a wrong bright line can pass as seen
  (the Monza chicane). Coverage says how often a line was seen, not how often it was right: check the pictures.
- **Corners where no lap used one side**: the recorded width is interpolated there and can be metres off; the line must be near it.
- **Edge definition**: the outer side of the paint, not where LMU's tarmac ends (0.1 to 0.2 m further out on Spa).
- **Services move**: both adapters depend on public URLs without a promise to last.
- **Finish line**: a kerb that crosses metre 0 is split in two, and a piece under 4 m is lost.

## Options

1. **Keep as a fill** for surveyed tracks: the survey's contacts first, imagery where there are none. Most accurate, needs both.
2. **Keep as the source for tracks without a survey**: no survey driving. Needs the Monza faults fixed and a look at the pictures per track.
3. **Drop**: the survey stays the only source, two weave laps of about 8 minutes per track plus the capture session.

**Recommendation: keep**, option 2 first (it removes the survey driving), experimental until the Monza faults are fixed and a third
track is checked. Kerbs from imagery stay experimental until their ends can be judged against something better than wheel hits.

## Decision (autopilot)

**Keep, as experimental: option 2, edges only** (Opus judge, 2026-11-25; the user may overrule).

- Spa meets the edge target without the survey in the fit, against 43 / 44 % of metres with a wheel contact in the survey. That can save a
  survey drive per track.
- It is one track, and the one used for tuning. On Monza, unseen, wrong lines were marked as seen, so coverage is not
  correctness. The survey stays preferred and no second track is served until the faults are fixed.
- Kerbs miss the 1 m target even after the correction and 29 of 65 survey runs are unmatched: drawing only, labelled experimental,
  never input to the coach or to metrics.
- Option 1 is deferred: its gain on Spa is unmeasured.
- Licences: the Spa vector file is acceptable in the public repo, and the SPW reading is accepted for Spa. AGEA is not accepted for
  committing derived data until its own notice is read. This does not extend to imagery or textures (vroom-ueg.9 needs its own decision).

# Ground texture beside the track (vroom-ueg.9)

**Question:** does the same orthophoto, draped over the ground beside the track, make the surroundings readable from the chase and
cockpit cameras, in place and at an acceptable cost?

**Answer:** yes on Spa for run-off, grass, gravel and painted areas, which sit in place. Buildings and trees are flat pictures. Ground height is
the weak point: real terrain can leave the track's level by 7 m only 30 m away, and an open terrain model fits LMU's heights to a few centimetres.

**Status:** experimental, off by default, dev server only. 3D view, View options, **Ground (experimental)**. The photo's credit is shown while it is drawn.

## Method

- **Tool:** `run.py ground spa` (see `tools/aerial-edges/README.md`). It repeats the fit of the first part and resamples the photo into 128 m
  squares in LMU's world frame, so the app needs no other transform: 25 cm per pixel where the centreline passes within 20 m, 1 m elsewhere, out
  to 150 m (`--reach`). `ground.json` holds each tile's position, the credit and the fit. Spa: 165 tiles (89 fine, 76 coarse), 5.0 MB of JPEG.
- **In the app:** `public/local-ground/<track_id>/` is git-ignored and stripped from builds, like the car models. Nothing is fetched until the toggle is on.
- **Mesh:** a 4 m grid, level with the nearest metre of track up to 12 m away, blending to a smooth mix of all track heights by 45 m, fading out from
  113 to 150 m. It is then carved under the road and kerbs. On Spa it never pokes through the road (41,880 points); at the edges it lies 6 cm below
  it (median), 15 cm at most.
- **Debug:** "Hide road" in the debug bar hides the road and kerbs, so the edge lines can be compared with the paint.

## Alignment

The painted line was found again in the finished tiles and compared with the edges the 3D view draws, in metres. "Seen" is the share of metres where
a line is visible. The search starts from the drawn edge (a wide prior, sigma 3 m), so it is not fully independent of it.

| Drawn edges | Where | Left: seen, median / p90 / max | Right: seen, median / p90 / max |
|---|---|---|---|
| Survey (the default) | La Source | 83 %, 0.15 / 0.39 / 0.72 | 98 %, 0.41 / 1.59 / **2.27** |
| | Eau Rouge | 100 %, 0.19 / 0.48 / 0.65 | 100 %, 0.21 / 0.36 / 0.43 |
| | Bus Stop | 100 %, 0.12 / 0.38 / 0.93 | 98 %, 0.17 / 0.36 / 0.67 |
| | Whole lap | 99 %, 0.22 / 0.45 / 0.97 | 100 %, 0.18 / 0.40 / 2.27 |
| Aerial | La Source | 83 %, 0.01 / 0.04 / 0.87 | 97 %, 0.02 / 0.08 / 0.44 |
| | Eau Rouge | 100 %, 0.01 / 0.06 / 0.08 | 100 %, 0.01 / 0.06 / 0.10 |
| | Bus Stop | 100 %, 0.03 / 0.22 / 0.44 | 98 %, 0.01 / 0.05 / 0.42 |

- **Within 1 m, with one exception**: with survey edges, 58 m on the right are off (99.2 % of the lap's right side is inside 1 m), nearly all at the
  exit of La Source (from about 347 m). The survey has no contacts there (11 to 17 m to the nearest for most of it) and falls back on LMU's width,
  so the drawn edge is off, not the photo. The aerial edges follow the paint there.
- The aerial rows come from the same photo and fit: they check the placing of the tiles, not the fit. The survey rows do test the fit.
- Kerbs: their inner side is drawn on the edge, so the sideways figures hold for them; they were not measured apart. Their ends are about 2 m off
  (first part), and Spa's are red and yellow in the photo.
- By eye: chase, cockpit and top pictures at the three corners, from headless Chromium driven by Playwright, the road hidden in the top ones.
  They hold imagery, so they are not committed.

## Cost

The benchmark HUD, uncapped frame rate, in headless Chromium on this machine's integrated AMD GPU (Mesa D3D12 under WSL). Window 2400 x 1500, 3D panel
787 x 1294. One run per column: frames per second (p95 ms of a frame; p95 ms of the draw call).

| Phase | `main` | Off | Off, again | Off, third | On |
|---|---|---|---|---|---|
| follow | 241 (6.4; 0.4) | 182 (11.0; 0.7) | 224 (6.8; 0.4) | 174 (13.3; 0.6) | 245 (7.4; 0.8) |
| scrub | 253 (7.0; 0.4) | 184 (10.5; 0.6) | 201 (8.4; 0.4) | 171 (13.9; 0.7) | 242 (7.2; 1.0) |
| orbit | 310 (5.8; 0.3) | 265 (6.7; 0.4) | 222 (6.8; 0.4) | 186 (12.8; 0.7) | 270 (6.3; 0.7) |
| cockpit | 204 (8.2; 1.0) | 197 (7.5; 1.1) | 202 (7.5; 0.9) | 146 (15.0; 2.2) | 194 (8.3; 1.8) |
| split | 267 (6.9; 0.5) | 237 (8.0; 0.6) | 240 (8.2; 0.6) | 256 (6.5; 0.5) | 245 (6.5; 0.8) |
| split-cockpit | 159 (8.8; 1.7) | 164 (7.7; 1.6) | 152 (9.9; 2.4) | 147 (8.6; 1.8) | 125 (18.1; **10.7**) |
| Draw calls, triangles (end of run) | 10, 192k | 10, 192k | 10, 192k | 10, 192k | 21, 209k |
| Textures on the GPU | not shown | 12 | 12 | 12 | 177 |
| GPU memory of the ground | | 0 | 0 | 0 | 131 MB textures, 9 MB mesh |

- **Other work was running on the machine**, and the runs with the ground off differ by up to 40 %, so only the split cockpit's drop and the higher draw
  times count as an effect of the ground. Every phase stays above 60 fps on average, but the split cockpit's p95 (18 ms) is over a 60 Hz frame.
  In a smaller panel (467 x 698) the split cockpit's draw p95 was 5.2 ms on against 2.1 ms off.
- **Off does the same work as `main`** (c44cb87): the same draw calls and triangles, and nothing is fetched or created. The frame rates scatter too much to prove more.
- **Memory** is computed (RGBA with mipmaps), as WebGL does not report it. A compressed texture format (KTX2) should cut it to a quarter or less; not tried.
- Turning it on, or changing the lap while it is on, blocks once for about a second while the heights are computed (0.9 s for 92 of the 165 tiles, in node,
  machine loaded). A worker, or a mesh built by the tool, would remove that. The tiles then upload one by one.

## Terrain heights

Wallonia's LiDAR terrain model (SPW, MNT 2021-2022, 50 cm) answers point queries on the same public server. `run.py ground spa --terrain 250` asked
it for 252 points:

| Where | Result |
|---|---|
| On the line, against LMU's recorded height (28 points, after a constant 394.4 m) | median 0.04 m, p90 0.14 m, max 0.18 m; slope 0.9993 |
| 10 m beside the line: terrain minus the terrain on the line | median 0.27 m, p90 0.49 m, max 1.1 m |
| 30 m beside | median 1.4 m, p90 7.4 m, max 12.4 m |
| 75 m beside | median 9.0 m, p90 17 m, max 30 m |
| 150 m beside | median 16 m, p90 30 m, max 48 m |

- LMU's Spa has the real heights, and the alignment of the first part holds for them.
- "Level with the track" is fine for the first 10 m and wrong beyond. **Worth a follow-up**: the tool would write a height per mesh node (4 m grid) into
  the manifest, which also removes the one-second stop. The bare-earth model has no buildings or trees; SPW's surface model (MNS) has, as rough shapes.
- Its licence was not read here: do that first. Point queries are too slow for a 4 m grid (over 100,000 nodes); a download or raster export is needed.

## Risks

- Things that stand up (trees, grandstands, barriers, parked and racing cars) lie flat, shadows are baked in, and close to the camera 25 cm is blurred.
- The pit lane and other roads show in the picture although the app draws none.
- A track that crosses itself (a bridge) gets one ground height there.
- Licence: the picture comes from SPW's viewing service. The reading of its terms in the first part covers edges; here about 85 more tiles are fetched and kept on
  the user's own machine only. Whether the picture may be shipped or served to others is not decided here, nor is AGEA's.

## Options

1. **Keep, experimental**, generated by each user for themselves, and do the terrain heights next.
2. **Change**: first the terrain heights and compressed textures, then decide.
3. **Drop**: the plain grass strip stays; the write-up and the terrain finding remain.

**Recommendation: keep (option 1).** Off it does no work, on it shows run-off and paint where they are, and the terrain model is the clear next step.
