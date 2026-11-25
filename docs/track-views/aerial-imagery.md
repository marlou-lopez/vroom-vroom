# Track edges and kerbs from open aerial imagery (vroom-ueg.8)

**Question:** can open aerial imagery give both edges and the kerbs of a whole track, accurately enough to replace or fill the
shared-memory survey (`edge-survey.md`), with a tool that is easy to run again for the next track?

**Answer:** yes for edges on Spa: 98 to 99.5 % of the lap on both sides, a median of 0.18 m (left) and 0.14 m (right) from the
wheel contacts, without driving a survey. Kerbs are found (no false run against the survey on Spa) but their ends miss the 1 m
target. Monza works with known local errors.

**Status:** experimental; the Le Mans blind check failed, see the end of this page. In the app: View options, Track edges, **Aerial (experimental)** in the Close-up view (Spa mock only).
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

Monza (no survey to grade against), first run: coverage 96.5 % left and 98.8 % right, 25 kerb runs. The check pictures showed: at the
first chicane both edges cut across the escape road instead of following the line, partly marked as seen; a false kerb on the bridge
over the track (about 3,580 m); kerbs that break into pieces, come out too wide or are missed.

**Confidence test (vroom-ueg.10, `tools/aerial-edges/confidence.py`, unit tests in `test_confidence.py`).** A traced line is written
as unseen when (a) within 15 m of a recorded LMU width it differs from it by more than 4 m (after the constant width bias; loose on
purpose, because on Spa the recorded width is itself 1-3 m off the painted line over about 250 m while the survey agrees with the
line), or (b) further from any recording, where the width is only interpolated (and was wrong by metres on Monza's pit straight), it
differs by more than 1.5 m from the median of its own seen line over +-150 m. A rejected run extends to where the line is back within
about 1 m and 2 m beyond; seen stretches under 6 m go. No kerb is kept beside an edge that is more than half unseen (this removes the
bridge kerb: the line is unseen under the bridge). Result: Spa coverage 95.7 % left and 96.5 % right (was 98.3 %), median error against
the survey 0.18 m and 0.14 m, p90 0.41 m and 0.33 m. Monza: 96.0 % and 97.6 %, 24 kerb runs; the chicane cut (about 425 to 505 m,
right) is unseen. All 17 pictures were looked at again: no seen edge is off the line by more than about 1 m (one borderline: left,
about 4,005 to 4,030 m, about 1 m too far out), and there is no kerb on the bridge.

The app's Spa copy (`spa-aerial-2023.json`) was regenerated with the test. Limits of rule (b): where under 50 m of the +-150 m window is seen it cannot judge, and a wrong line longer than about 150 m is its own median; check pictures stay necessary on a new track (vroom-ueg.11).

Kerb outcomes on Monza are not fixed by this issue: two false runs (left, about 3,900 m on run-off and about 4,728 m at a gantry
pole), one clearly missed kerb (right, about 2,855 to 2,898 m), two missed small ones (about 2,135 to 2,175 m) and several kerbs only
partly covered (about 957 to 1,050 m, 3,277 to 3,305 m, 4,110 to 4,150 m). So Monza stays out of the app.

## Sources and licences per LMU track

Spa, Monza and Le Mans services were used. The rest comes from catalogue pages
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
2. **Keep as the source for tracks without a survey**: no survey driving. The Monza edge faults are fixed (kerb faults remain, see above); each track still needs a look at its pictures.
3. **Drop**: the survey stays the only source, two weave laps of about 8 minutes per track plus the capture session.

**Recommendation: keep**, option 2 first (it removes the survey driving), experimental until the Monza kerb faults are fixed and a third
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

## Blind check on Le Mans (vroom-ueg.11)

**Question:** with the code and thresholds frozen (commit `2470fea`), does a third track pass with only an adapter and a track file?

**Answer: no.** The frozen run fails at the alignment. A second run with better OSM input also misses both limits.

| | Limit | Frozen run (the blind result) | Diagnostic run (not blind: only the OSM input swapped) |
|---|---|---|---|
| Coarse: scale, rotation | | 0.760, 4.20 deg | 0.9997, 2.05 deg |
| Coarse: distance to OSM, median / p90 | | 167 / 730 m | 0.54 / 1.91 m |
| Refined: scale, rotation, moved from coarse | | 0.761, 4.21 deg, 2.1 m | 0.9998, 2.064 deg, 0.38 m |
| Residual to the recorded widths, median / p90 | median < 0.2 m | **1.19** / 3.62 m | **0.71** / 1.76 m |
| Constant width difference | | 0.23 m | -0.71 m |
| Coverage, left / right | | 8.9 / 10.1 % | 80.1 / 84.3 % |
| Rejected by the confidence test, left / right | | 413 / 549 m | 426 / 237 m |
| Wrong but seen, left / right / both | < 2 % | **all of it** (about 2,600 m) | 193 m (1.8 %) / 364 m (3.2 %) / **557 m (2.5 %)** |
| Unclear by eye | | | 131 m / 75 m (3.4 % in all if every one is wrong) |
| Kerb runs | | 1 (false) | 25 |

- **Set-up:** `tools/aerial-edges/sources/ign_bdortho.py` (20 cm, Lambert-93, 128 m tiles, flown 2025-07-09 according to IGN's mosaic
  graph), `tracks/le-mans.json`, the timed laps within 5 % of the fastest from 10 GT3 recordings (13,621 m; a recorded width exists on 78 %
  of the metres left, 98 % right). No code or threshold was changed. The laps file sits in the git-ignored `cache/`: make each recording's JSON with
  `extract-laps.mjs` and put the timed laps of all of them in one `{"laps": [...]}`. There is no survey, so nothing but the recorded
  widths and the pictures grades it.
- **Why the frozen run fails:** the tool aligns on OSM `highway=raceway`. About half the lap is public road (the Hunaudières straight
  is `primary`, D 338; Mulsanne to Arnage is D 140), so the trimmed fit shrinks the lap onto the permanent part.
- **Diagnostic run:** only the cached OSM answer was replaced by `raceway` plus the ways with `ref` D 338 or D 140 in
  47.905, 0.205, 47.965, 0.25 (this was chosen after seeing the failure, so it is not blind and the tool cannot do it by itself). About
  10 to 11 km, on D 139, still has no OSM line; the trimming copes.
- **Pictures:** all 39 of the frozen run were looked at on a contact sheet (forest, fields, car parks). All 39 of the diagnostic run were
  looked at by two Opus subagents, enlarged where doubtful; wrong means over 1 m from the line. The session looked at five of them and found
  the same. A person should not expect better than about 1-2 m on each boundary.
- **What is wrong (diagnostic run):** the verge, a wall or house fronts where the road's dashes are faint (right 3,600 to 3,836 m, 185 m; right
  2,617 to 2,692 m, 70 m; left 7,873 to 8,013 m, 136 m; left about 6,250 and 6,381 m, 37 m); other roads' lines at junctions;
  a truck, a van and a hatched island. One run on the permanent circuit: right 12,313 to 12,328 m, an escape road's line. None of it
  was caught by the confidence test, because the recorded width there is 1 to 2.5 m wider than the line (next point).
- **The painted line is not LMU's edge on the public roads.** Per kilometre, imagery minus recorded width: within 0.3 m at the median on the
  permanent circuit (0 to 2 km, 12 to 13.6 km), but -0.4 to -2.5 m on 2 to 11 km, on both sides. LMU's road is wider than the painted
  lane there (or the painted line is not its limit). So even a perfectly traced line gives the wrong edge on much of this lap. Which one
  LMU enforces needs a survey or a look in the game.
- **Kerbs (diagnostic run):** no false run; three clearly too wide (right about 860 to 925, 1,055 to 1,092 and 13,251 to 13,273 m); many
  missed (about 30 stretches), mostly on the chicanes and the Porsche curves.
- **Post-hoc split, not part of the test:** on the permanent circuit (0 to 2,000 and 11,550 to 13,621 m) wrong-but-seen is 15 m (0.2 %), with 112 m unclear. Its limit was not
  set beforehand, and residual and coverage were not recomputed for that part.

**Terms, read first-hand on 2026-11-25:** the Géoplateforme conditions (cartes.gouv.fr/cgu, version of 15 October 2024; the service's
capabilities name them, with fees "none") ask for no key, conforming use, no hindering of the service, 40 requests/s per IP on WMS-Raster (the tool makes about 2) and respect for each dataset's licence. IGN's metadata
for BD ORTHO says Licence Ouverte / Open Licence, no public-access limits. Licence Ouverte 2.0 (PDF) grants copying, adapting, extracting and
making derived information, commercial or not, on one duty: name the source and the date of its last update, without suggesting
endorsement. So derived vectors could be published with "IGN, BD ORTHO, flown 2025-07-09". This is better founded than SPW's or AGEA's.
Not legal advice. None of the derived Le Mans data is committed or served.

**Options**

1. **Drop imagery as a supported source for tracks without a survey.** The survey stays the source; the Spa copy stays an experimental
   extra or goes too.
2. **Keep it experimental for permanent circuits only**, with an OSM check that refuses a lap OSM's raceway does not cover. Would need its own
   blind test on a permanent track (Paul Ricard has no recordings here; Portimão, Fuji and Bahrain do, but only Portimão has an open source).
3. **Keep working on it** (other road classes in the alignment, a judgement of vehicles, faint lines). Le Mans would then be a tuning track.

**Recommendation: drop (option 1), as the acceptance criteria say for a missed limit.** Both limits are missed, and the main fault (paint
is not LMU's edge on a road course) is not one a threshold can fix.
