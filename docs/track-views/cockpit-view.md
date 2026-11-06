# Cockpit camera in the 3D view (#100)

**Question:** can the 3D ribbon view (#39) show a lap from the driver's seat, using only what an LMU recording has (no orientation channel), and how wrong is the car's attitude when it is estimated?

**Status:** prototype in the 3D view's camera bar ("Cockpit", next to Chase, Orbit and Top; the view is marked *experimental*). **Decision: pending the user's keep / change / drop.** The view could not be looked at while building it (no browser), so everything visual below is untested by eye; the numbers are from the capture.

## What it does

- **Cockpit camera** (`ribbon/cockpit.ts`, `CockpitRig` in `ribbon/cameraRigs.ts`): the camera sits at the lap car's eye and looks along the estimated attitude. It fills `CameraFrame.eye`, which was reserved for it. The wheel does nothing in this mode (fixed field of view).
- **Cars:** the lap car's box is hidden (it is the camera); the reference car stays as the ghost.
- **Surroundings, cockpit mode only** (the other cameras look as before): a grass verge on each side of the track (70 m wide, following the road heights at the same metre, 4 cm below the road, two greens in 25 m mowing bands, fading to the haze colour at its outer edge), a sky dome (haze at the horizon, rising to a sky blue overhead) and fog in the haze colour (150 to 2200 m). Colours are theme tokens (`--color-sky`, `--color-sky-horizon`, `--color-grass`, `--color-grass-alt` in `src/theme.ts`). The verge is flat across its width (no terrain beside the road is known); at a hairpin its inner side overlaps itself, which is invisible because it is one colour.
- **Works for any lap with GPS**, with or without a capture: heading from the GPS line, road slope from the elevation (flat without it), dive and body roll from the grid's G channels, plus the road's banking from the track survey when the track has one.

## Eye constants (`ribbon/cockpit.ts`; height, seat and tilt measured, see Calibration)

| Constant | Value | Why |
|---|---|---|
| `EYE_HEIGHT_M` | 0.98 m | Measured (Calibration). The drawn road is the car reference point's height (as in the rest of the view), so this is measured from the drawn road. |
| `EYE_LEFT_M` | 0.11 m left | Measured (Calibration): the seat is only slightly left of the centreline. |
| `EYE_PITCH_DOWN_DEG` | 1.5 degrees | Measured (Calibration). The camera looks this far below the car's own pitch (applied in `CockpitRig`), so there is more road and less sky. |
| `EYE_FORWARD_M` | 0.3 m ahead of the car's visual centre | Measured from the visual centre (the recorded point plus LMU's graphical offset, below), no longer from the recorded point; the value is unchanged and still an estimate (not measured). The 720S GT3 wheelbase is 2.696 m (`CarDims.wheelbase_m`), so the eye is roughly 1.0 m behind the front axle if the visual centre is mid-wheelbase, a plausible GT3 seat position; no axle-relative constant is used yet. |
| `COCKPIT_FOV` | 44 degrees vertical | Mirrors LMU's own `Vertical FOV Degrees` setting from the user's `UserData/player/Settings.JSON` (44; 9 means "use default"). As in LMU, the horizontal field follows the browser panel's aspect ratio (three.js's vertical FOV works the same way). The frontend cannot read local files, so the value is a constant; a future backend could read the setting from the user's LMU install and pass it in (not built). The other modes keep 55. |
| near plane | 0.1 m | So the kerbs and the road under the nose are not clipped. |

## Calibration

Method: the car parked at two spots on the Kemmel straight (lap distance 1,743 m, 4.4 m left of LMU's centre path; 1,818 m, 3.9 m right), cockpit view, the user's normal seat, vertical FOV 44 degrees, 1920x1080 screenshots. The poses came from a logger capture while stationary, so no timing sync was needed. LMU does not update shared memory during replays (tested: 0 frames), which is why parked screenshots were used.

- **Height and seat.** A straight edge line on the road plane appears in the image with slope dX/dY = (lateral distance of the edge from the eye) / (eye height), independent of yaw and pitch. Measured slopes: left edge 1.823, right edge 2.083. The edge positions at the car came from the survey's wheel-contact points fitted with a line: the left edge 1.90 m left of the car centre (45 points, residual 0.02 m), the right edge 1.94 m right (only 7 points, 78 to 87 m ahead, so extrapolated). Solving gives **eye height 0.98 m and seat 0.11 m left of the centre line**. Using LMU's `mTrackEdge` widths instead (1.82 m / 1.72 m) gives 0.91 m and 0.17 m, so the uncertainty is about 0.05 m.
- **Tilt.** The line intercepts give **1.52 and 1.47 degrees down** relative to the car; an earlier replay screenshot's vanishing point gave 1.7. The shipped value is 1.5.
- **Forward position:** still an estimate (0.3 m ahead of the visual centre), not measured.
- The scripts used are not in the repo (one-off analysis).

## Car dimensions and the visual centre

- **Dimensions** (mock, McLaren 720S GT3): length 4.664 m, width 2.040 m, wheelbase 2.696 m, from McLaren's customer-racing technical sheet (https://mclaren.pagetiger.com/coeljug/1/page3.htm) and https://www.ultimatecarpage.com/spec/6972/McLaren-720S-GT3.html. These are the original 720S GT3 figures; no Evo-specific sheet was found and the mock's car is the Evo. `CarDims` gained an optional `wheelbase_m`. Unknown cars (the Porsche in the mock) still fall back to the generic 4.7 x 2.0 m.
- **`mPhysicsToGraphicsOffset`** (telemetry, float[3], "offset from static CG to graphical center", vehicle axes +x left, +y up, +z back) was read from the player in all four 2026-11-06 captures (about 375,000 samples): **(-0.0, -0.3335, -0.0745) m, constant in every sample**. So the visual centre is 7.45 cm ahead of the recorded position and 33.35 cm below it, with no lateral offset (plausible: the CG is about a third of a metre above the model's ground-level origin, a little behind mid-length). The recording's GPS is a fixed transform of `mPos`, so the recorded point is the CG, not the visual centre.
- **Applied: the forward part (7.45 cm, a little over the 5 cm threshold).** `CarDims.visual_offset = { forward_m, up_m }` (optional, per car; the 720S in the mock, null for unknown cars = no shift). The 2D footprint and the 3D box are moved forward by `forward_m`, and the cockpit eye is measured from the visual centre (eye forward = 0.3 m + 7.45 cm from the recorded point). It is a per-car constant, so a backend must supply it per car (read from a capture once).
- **Not applied: the 33 cm drop.** Every height in the view (road, edges, kerbs, the survey) comes from the same `mPos.y`, so the drawn road sits at the CG's height and the true tarmac is probably about 0.33 m lower everywhere. Shifting only the car or the eye by 0.33 m would put it 0.33 m too low against that road; the clean fix is to lower the whole scene by a per-car constant, which is a pipeline change. That interpretation (that the graphical centre is at ground level) is unverified. `EYE_HEIGHT_M` and `CAR_BODY_Y` are measured over the drawn road and absorb it (the calibration below measured the eye height over the drawn road). The drop is carried in `visual_offset.up_m` and is unused.

## Attitude model (`frontend/src/lib/carAttitude.ts`, pure and unit-tested)

All per grid metre, then interpolated at the car's fractional distance:
- **Heading** = direction of the chord of the lap's line from 5 m behind to 5 m ahead (the 3D view's car line: GPS smoothed over 9 m, blended with the lateral-offset line). Nothing more is smoothed; it is no rougher than the true yaw (RMS change of turn rate 0.087 deg per m² against 0.128).
- **Pitch** = road slope (the 3D view's own, exaggerated with the elevation slider) + `PITCH_REST` + `K_PITCH` x longitudinal g. Braking (`g_long > 0`) pitches the nose down.
- **Roll** = `K_ROLL` x lateral g + the road bank. Positive = leaning right; `g_lat > 0` is a left turn. The bank is `TrackSurvey.bank_deg` (degrees per grid metre, from the survey captures, see below), averaged over 9 m; without a survey, or where it is null, the bank is 0 and the roll is body roll only.
- G channels are averaged over 9 m first. Gains: `PITCH_REST` -0.22 deg, `K_PITCH` -0.294 deg per g, `K_ROLL` +0.476 deg per g (the physical outward body roll; the banking is added separately).

Conventions are written at the top of the file and tested (north = pi/2, nose up and lean right positive, braking and left turn positive). The camera applies them as a three.js Euler (YXZ): yaw `heading - pi/2`, pitch about x, roll about z negated.

## Validation against the capture

Method: `tools/lmu-logger/attitude_check.py` (reproducible; its docstring has the command). The 2026-11-05 Spa session's recording (grid from `tools/extract-laps.mjs`) and its all-cars capture share a clock, so each grid metre gets a time and the capture's `mOri` gives the true yaw, pitch and roll there (vehicle +x left, +y up, +z back; forward is -z; checked again here: the left vector points to the left of the travel direction in the world, 0.9996). Lap 0 is the out-lap, lap 1 the flying lap (143.78 s), lap 2 the in-lap. Pitch gains fitted on lap 1; laps 0 and 2 are the check. Errors in degrees, median / 90th percentile / max, with the shipped constants:

| Lap | Pitch (slope + dive) | Pitch, slope only | Roll, body only | Roll, none | Roll with road bank, 11-06 captures only | Roll with road bank, all four captures | Slip angle |
|---|---|---|---|---|---|---|---|
| 0 out | 0.06 / 0.15 / 0.81 | 0.16 / 0.49 / 0.93 | 1.68 / 2.78 / 4.69 | 1.29 / 2.52 / 4.26 | **0.30 / 1.06 / 4.44** | 0.22 / 0.89 / 4.44 | 0.29 / 1.16 / 92 |
| **1 flying** | **0.06 / 0.15 / 0.63** | 0.16 / 0.50 / 0.96 | 1.70 / 2.98 / 5.08 | 1.32 / 2.55 / 4.84 | **0.28 / 0.98 / 4.80** | 0.20 / 0.76 / 4.68 | **0.31 / 1.26 / 4.98** |
| 2 in | 0.07 / 0.16 / 0.93 | 0.17 / 0.52 / 0.99 | 1.69 / 2.94 / 4.96 | 1.32 / 2.60 / 4.65 | **0.29 / 1.08 / 4.58** | 0.21 / 0.92 / 4.27 | 0.32 / 1.32 / 41 |

The same numbers come out of the TypeScript on the flying lap (`carAttitude.spa.test.ts`, with a 112 kB gzipped fixture of the lap's inputs and truth, and the committed survey: pitch 0.063 / 0.156 / 0.63, roll without bank 1.70 / 2.98 / 5.08, with the committed survey (all four captures) 0.199 / 0.762 / 4.67, slip 0.31 / 1.26 / 5.0).

- **Pitch is good.** Road slope alone is already 0.16 deg off; the dive term brings the median to 0.06 deg. The fitted brake dive is small, about 0.3 deg per g (0.5 deg at 1.7 g).
- **Slip angle** (true yaw minus path heading, flying lap): median 0.31 deg, 90th percentile 1.26, 5th to 95th percentile -1.17 to +1.31, mean +0.02, 131 of 6979 metres above 2 deg (1.9 %), max 5.0. The maxima of 92 and 41 deg on the out-lap and in-lap are spins or the pit lane, not driving on the track. The estimate's error therefore includes this slip; it is small for a clean lap. A slide of a few degrees at the limit is invisible to a recording, but nothing like that happened on this lap.
- **Roll is body roll plus the road's banking, and the banking is most of it.** The body rolls outward by **+0.476 deg per g** of lateral g. That gain comes from fitting the same metre of road across the three laps, which removes anything that depends on the place. A fit on the flying lap alone gives the opposite sign (-0.985 deg per g) because Spa's banking repeats every lap at the same metre and correlates with the corners; the first version of this view shipped that and it was dropped, as it would tilt the wrong way on a track without Spa's banking. Body roll alone is worse than no roll at Spa (1.70 against 1.32 deg median), because the banking, up to a few degrees, is missing. Left minus right suspension travel does not help (0.76 deg median): the body moves with the road, not against the suspension.
- **Road bank from the survey** (`bank_deg`, `decode.py survey`): for every car on tarmac with all four wheels, roll from `mOri` minus 0.476 x its lateral g (from `mLocalAccel`, which equals the recording's `g_lat`: correlation 0.9989, slope 0.997). Samples are averaged per 4 m cell, mapped to the grid like the edges (median of the nearest samples within 15 m, gaps up to 8 m interpolated), and smoothed over 9 m by the estimator. The Spa file has 5,262 cells (4,438 without the all-cars capture), and the survey file grew from 864 kB to 970 kB. **Independent check:** the bank built only from the three 2026-11-06 captures (survey laps, contact laps and weave laps, none of which is the 2026-11-05 session) takes the roll error on the 2026-11-05 laps from 1.7 deg median / 2.9 at the 90th percentile (body roll only) down to **0.30 / 1.06 (out-lap), 0.28 / 0.98 (flying lap), 0.29 / 1.08 (in-lap)**, against 1.3 deg median with no roll at all. With all four captures (the committed file) it is 0.22 / 0.89, 0.20 / 0.76 and 0.21 / 0.92. The remaining maxima of 4 to 5 deg are single spots (kerbs and the pit entry). The bank estimate was not tuned beyond a 4 m cell and 9 m smoothing.

## The cockpit: trim, mirror, displays and wheel (#101)

**Status:** built, **not looked at in a browser** (none was available here); layout numbers come from the screenshots, the rest is from code and tests. **Decision: pending.**

The cockpit view always draws our own cockpit, original artwork placed from the user's screenshots; loading a model's interior was tried and removed (see `car-model.md`). Everything follows playback (also while scrubbing) at the lap car's current distance, and shows in cockpit mode only.

### What is drawn (`ribbon/cockpitDash.ts`, 10 draw calls, one camera-attached group)

| Piece | What | How |
|---|---|---|
| Trim | The surround of the measured windscreen opening, shaded as a roof header (lit just above the glass, sinking towards the top), an A-pillar (lit along the glass edge) and a dash top (catching light along the windscreen's lower edge) | `cockpitFrame.ts`: the frame mesh with a small shader (zone shading in tan space and a plain carbon weave, 150 cells per tan unit, low contrast, faded out once a cell is under about 3 px so it does not shimmer when small) |
| Side window | A second opening in the trim, behind the A-pillar on the left (`SIDE_WINDOW`, see Left side window below): the pillar is a pillar with scene on both sides, lit along the window's edge too | the same frame mesh with a second hole; the shader adds the window's edge light (distance to the polygon's edges) |
| Lit edge | A thin lighter ribbon along the opening and along the side window's edge | `buildOpeningEdgeGeometry`, vertex colours fading to nothing |
| Bonnet | A sliver at each lower corner of the windscreen, in `cockpitBonnet` (a neutral silver-grey), lighter at the top | vertex-colour gradient in y (exact on any triangulation) |
| Dash top | The binnacle round the central display, a switch pod to its left, and the second display's shroud: carbon weave, a lit top lip, recessed bays, small vent marks | one canvas texture, painted once |
| Mirror | A housing in the roof header and a live picture | see below |
| Central display | Shift lights (with a halo when lit), gear (large; red while the lights flash), rpm, speed, throttle (green) and brake (red) bars | canvas, redrawn only when a shown value changes (`dashKey`) |
| Second display | **The live delta to the reference lap** (`CompareResponse.delta`, red when behind, green when ahead) with a bar around its middle, full scale 1 s | canvas, redrawn when the delta changes at 0.01 s |
| Wheel | A rounded-rectangle (GT-style) rim, a cross spoke, a lower spoke, a square hub and an orange 12 o'clock marker across the rim's top; colours from the theme | one canvas texture on a plane turned about the hub by `steering x range / 2` (+ = right = clockwise; 360 degrees nominal range for an unknown car), so turning costs no redraw. Drawn last, in front of the dash top, the displays and the mirror, with the depth test off |

**Why the delta on the second display:** it is the one number the whole app is about (where time is lost against the reference), it is already in the data (no new channel, no map to build), and it is cheap (a small redraw only when it changes at two decimals). A tiny map was the alternative; it needs the track outline projected into a second view for little the main view does not show. The distance was dropped because it changes every few metres.

**Why canvas textures:** crisp text and gradients with no HTML overlay to keep in step with the camera, and the static parts are painted once. The colours all come from theme tokens (`--color-cockpit-interior`, `--color-cockpit-trim`, `--color-cockpit-bonnet` are new, the rest the existing ones, read once per renderer by `readCockpitPalette`). Draw order is by `renderOrder` with the depth test off: trim, edges, bonnet, dash top, mirror housing, mirror glass, displays, wheel (the trim and bonnet are opaque and drawn first; everything else is in the transparent queue, sorted by `renderOrder`, and the wheel is last).

### Rear-view mirror (`ribbon/cockpitMirror.ts`)

A real mirror: a second perspective camera at the eye looking back (the view direction with its horizontal part reversed and its up/down part kept, the car's up vector kept so a leaning car tilts the picture with the windscreen), vertical FOV 14 degrees at the glass's aspect (about 74 degrees across), rendered into a 768 x 103 render target (4x multisampled, sRGB) and shown on the glass flipped left-right. It is redrawn at most every 28 ms (every other frame at 60 fps, or at every draw when draws are sparser, for example while scrubbing or after a seek), with the cockpit hidden during its pass and the lines' pixel resolution set to the target's. `?mirror=0` in the URL turns the pass off and shows a still sky-and-verge picture instead.

**Cost: not measured.** No browser or GPU was available. What can be said from the code: the pass is the scene again (about 9 calls for ribbon, kerbs and the six lines, plus the verge's two meshes, the sky and the ghost: about 15 with the box ghost, more with a loaded model, which is also drawn behind the car) at 79k pixels (3.8 % of a 1080p frame, before the MSAA), at most every other frame. The cockpit overlay adds 10 calls to the main pass. The 3D view's HUD calls figure now counts both passes (`gl.info` is reset once per frame). To measure: open the 3D view with `?debug` and run the benchmark (now four phases: follow, scrub, orbit, cockpit); run it again with `?mirror=0` and compare the cockpit rows (fps, p95 frame and draw ms). If the mirror costs too much, `?mirror=0` is the whole fallback (or set `LIVE_MIRROR` false in `threeRibbon.ts`).

### Measured placement (1920x1080 screenshots, vertical FOV 44 degrees)

Scale 540 / tan 22 degrees = 1336.6 px per tan unit: tx = (x - 960) / 1336.6, ty = (540 - y) / 1336.6. The windscreen opening (`COCKPIT_OPENING`) was measured earlier by pixel comparison across screenshots. **The rest was read by eye from `kemmel-left.png`, `kemmel-right.png`, `eau-rouge.png`, `la-source.png` and the replay screenshots 3 to 5 (about +-5 px, so +-0.004 tan), not found by pixel comparison**, apart from the wheel centre. All in `ribbon/cockpitLayout.ts`, with tests that keep the pieces where they should be relative to each other.

| Piece | Screenshot px | tan (tx, ty) | Ours |
|---|---|---|---|
| Mirror glass (the game's rear-view picture, top centre) | x 555..1365, y 10..118 | tx -0.303..0.303, ty 0.316..0.397 | centre (0, 0.3565), 0.606 x 0.081; housing 0.646 x 0.101, top at the view's top (0.404) |
| Central display screen | x 783..1125, y 722..870 | tx -0.132..0.123, ty -0.247..-0.136 | centre (-0.0045, -0.1915), 0.255 x 0.111 |
| Binnacle (shroud of the central display) | top y 672 to 690, flaring out at x 655 | ty about -0.10 to -0.11, left edge tx -0.23 | x -0.195..0.185, top -0.100, corner radius 0.075 |
| Switch pod left of it | x 420..690, y 770..900 | tx -0.404..-0.202, ty -0.172..-0.269 | centre (-0.304, -0.222), 0.2 x 0.1 |
| Second display screen | x 1322..1668, y 730..910 | tx 0.271..0.530, ty -0.277..-0.142 | centre (0.4005, -0.2095), 0.259 x 0.135 |
| Its shroud | x 1268..1735, top y 680 | tx 0.230..0.580, ty top -0.105 | centre (0.405, -0.225), 0.35 x 0.24 |
| Bonnet, left | x 395..750, top y 630 to 665 | tx -0.42..-0.157, ty -0.069..-0.093 | on the opening's lower edge (-0.09), up to -0.0655 |
| Bonnet, right | x 1650 on, top y 645 | tx 0.516 on, ty -0.079 | up to -0.059, tapering to the right |
| Wheel hub (see below) | (952, 1073) | (-0.006, -0.399) | the same; plane 0.66 x 0.41 |
| Wheel rim, half width | grips 302 to 364 px from the hub | 0.22 to 0.27 | rim half width 0.26 (a rounded rectangle, not the game's butterfly) |
| Wheel rim top | the game's plate top y about 885 | ty -0.26 | -0.254 (hub + 0.145), just under the display's bottom edge (-0.247) |

**Wheel centre:** the wheel turned between `kemmel-left.png` (straight) and `la-source.png` (turned) about a point found as the intersection of the perpendicular bisectors of two features' displacements (the yellow knob (668, 845) to (700, 810), the red button (1192, 890) to (1215, 925)): **pixel (952, 1073), tan (-0.006, -0.399)**, at the bottom edge of the screen; the two features agree on about 7.5 degrees of turn between the shots. Only these two screenshots were used for the centre. Because the hub is at the bottom edge, only the upper half of our wheel shows, and the rim's top is only 0.007 below the display's bottom edge (-0.247). **The wheel is the first design (a rounded-rectangle rim, a cross spoke, a lower spoke, a hub and a marker) again:** the user preferred it to the flat-bottomed butterfly with buttons that replaced it. It is drawn in front of everything in the dash (an earlier version put it behind the displays so it would not cover them, which looked broken when turned: the rim vanished under the display). Instead it is slim, so the display shows through its openings: rim thickness 10 % of the half size (0.026 at the sides, 0.0145 at the top and bottom), spokes 0.02 thick, hub 0.064 square (`WHEEL_RIM_INNER` 0.9, `WHEEL_SPOKE_HALF` 0.01, `WHEEL_HUB_HALF` 0.032).

**What the turned wheel covers** (`wheelCoverage` in `cockpitLayout.ts`, the same shapes `paintWheel` draws, sampled on a grid, steering angles -180 to +180 degrees in 15 degree steps; the gear digit is the 136 px "4" glyph's box, about 76 x 98 px of the 560 x 244 display canvas, and the lights are the row of ten dots, x 44..516, y 20..44):

| | worst | median | straight ahead |
|---|---|---|---|
| Gear digit | 47 % (at +-90 and +-165 degrees, where a spoke crosses it) | 0 % | 0 % |
| Shift-light row | 85 % (at +-90 degrees: the rim's side bar passes through the row) | 0.7 % | 0 % |
| Whole display | 33 % (at +-90 degrees) | 13 % | 0 % |

The gear digit is never fully covered (a test checks that, and that the medians stay under 5 %); the light row is covered only for turns of about 75 to 105 degrees either way (the rim's side bar, unavoidable for a rim as wide as the game's, half width 0.26) and is clear at 0 to 60 degrees and at 120 to 180. **Clipping:** the wheel is one plane that turns with its content (content half extents 0.26 x 0.148 inside the plane's 0.33 x 0.205), at the same depth as the rest (0.15 m, beyond the 0.1 m near plane, turned about the view axis only), so neither the near plane nor the plane's edge cuts it at any angle; nothing is drawn after it, and the trim, bonnet and dash-top regions are drawn before it.

**Original, or taken from the screenshots?** Only the *positions and proportions* above are from the user's screenshots. The shapes, the carbon weave, the gradients, the display layouts, the wheel's design and the delta display are ours; no logo, text, livery, texture, McLaren or LMU dash layout or graphic is copied, and no game file was used. The roof text, the mirror's content and the display contents in the screenshots were not reproduced.

### Left side window (`SIDE_WINDOW` in `ribbon/cockpitFrame.ts`)

Left of the A-pillar the view used to be solid trim. The camera-locked static mask (`calib/mask.png`, white = scene) shows a sliver of scene at the screen's left edge, behind the roll-cage tube and the A-pillar: at x = 0 it spans y 488 to 660, at x = 12 it is 504 to 636, at x = 24 520 to 612, at x = 36 532 to 592 and at x = 48 552 to 564; it ends in a point at about (52, 558). That is a triangle: its top edge is the cage tube / A-pillar's outer edge falling to the right, its bottom edge the door's top (the sill) rising to the right. Scale as above, so at 16:9 the window is only the leftmost 6 % of the width (tx -0.718 to -0.679). The mask's other white specks left of x = 100 are the cage's reflections and the seat belt, not window.

Polygon (tan, clockwise):

| Point | px at 1920x1080 | (tx, ty) | |
|---|---|---|---|
| top-left (rear edge) | designed | (-1.30, 0.15) | the rear edge: a vertical at tx -1.3: outside a 21:9 view (edge at -0.94) but inside a 32:9 one (edge at -1.44) |
| roof edge | designed | (-0.95, 0.14), (-0.80, 0.108) | the top edge flattens to the roof edge, near the windscreen's top (0.154 to 0.18) |
| cage tube | (0, 488) | (-0.718, 0.0389) | **measured**: top edge at the 16:9 view's left edge |
| apex | (52, 558) | (-0.679, -0.0135) | **measured**: where the sliver ends |
| sill at the view edge | (0, 660) | (-0.718, -0.0898) | **measured**: the door's top at the 16:9 view's left edge (the same height as the windscreen's lower edge) |
| sill | designed | (-0.80, -0.10), (-1.30, -0.115) | the sill runs on almost level |

**Measured:** the three points at the 16:9 view's left edge and the apex. **Designed:** everything left of tx -0.718 (the roof edge, the level sill and the rear edge), because the 44 degree FOV at 16:9 shows nothing there; a wider window shows these parts, and the real car's side window will differ in detail. The frame is built with the window as a second hole, the trim shader lights the pillar, sill and roof edge along the window's outline, and `buildOpeningEdgeGeometry` gives it a lit edge like the windscreen's. Tests (`cockpitFrame.test.ts`): a direction just left of the pillar inside the window is open (-0.7, -0.01), the pillar itself, the sill, the roof and the area behind the rear edge are covered. **No glass tint** (the window is a plain opening, like the windscreen). **No door mirror:** it would need either a second extra render pass (the rear-view mirror already costs one) or a still picture; the visible sliver at 16:9 is too small to show a mirror, and none of the screenshots shows the game's door mirror, so there was nothing to place. A mirror could be added for wide windows if wanted.

### Rev limit and shift lights (`lib/shiftLights.ts`)

- **Method:** for each upshift on the lap (gear rises from a forward gear), take the highest rpm in the 3 metres before it (`preUpshiftRpm`). The limit is the 90th percentile of those (`deriveRpmLimits`); with fewer than 3 upshifts it falls back to the lap's highest rpm; no usable rpm gives null (lights stay dark). No per-car table.
- **Lights:** the first light comes on at 80 % of the limit (`START_FRACTION`), the rest fill evenly up to the limit; from 98.5 % of the limit (`FLASH_FRACTION`) all lights blink at 6 Hz, driven by the playback time (so the blink follows playback and scrubbing, and is frozen at one phase while paused). The first 4 lights are green, the next 4 yellow and the last 2 red.
- **On the Spa laps (4 and 3, 720S, `shiftLights.spa.test.ts`):** 18 and 19 upshifts, pre-upshift rpm 7,305 to 7,875; limit **7,598** (lap 4) and **7,658** (lap 3), the highest rpm of the laps 7,903 and 7,937; so the first light comes on at about 6,080 and 6,130 rpm, and the lights flash from about 7,480 and 7,540 rpm. These limits are shift points of a fast lap, a little under the true limiter.

### Not verified

Everything visual: the carbon weave's contrast and scale, the zone shading, the shader (it compiles only in a browser: a GLSL error would show as a black or missing trim, and the console would say), the mirror (orientation, the flip, whether the sRGB render target round-trips without a colour shift, its cost), the bonnet's size, how the slim wheel reads over the displays when turned, the side window (its shape, and whether the shader's edge light reads well), the fonts on the displays (Inter, falling back to the system font if it has not loaded when the first value is drawn; later changes redraw), and any of the positions by eye against a real frame.

## What is missing

- **Slides.** A slide shows in the slip angle, which a recording cannot give; the estimate points the nose along the path. On this lap that is within 1.3 deg 90 % of the time. It would be wrong in a drift or a spin.
- **Road banking on tracks without a survey:** the roll is body roll only there, which is a fraction of what Spa shows (see above). A survey needs no extra driving beyond what the edges need; the bank comes from the same captures.
- **Kerb and bump motion** (the body and eye shake over kerbs, vertical g), hands, sound. (The steering wheel, a dash, a second display and a rear-view mirror are in, see The cockpit above.)
- **The terrain beside the road** (the verge is flat across its width), trees, buildings, run-off, the pit lane.
- **Eye position per car and seat position**: the constants are one calibration (McLaren 720S GT3, the user's seat) for all cars.

## Is exact orientation from a capture worth a follow-up?

Not for pitch, heading or, now, roll. With a recording and the track survey the pitch is 0.06 deg median off, the heading 0.3 deg and the roll 0.3 deg (about 1 deg at the 90th percentile), far below what shows on screen, for every lap of that track and with no capture of the lap watched. Exact orientation from a capture would only help laps that have a capture, and would add slides (drift or spins) that the estimate cannot show; it is worth doing only if the coach starts to talk about slides.

Other follow-ups if the cockpit view is kept: add ride heights and suspension to the extractor's grid (front minus rear ride height predicts pitch to 0.03 deg median, so not needed for this); a free-look drag; measure the forward eye position the same way.

## Not checked

- The view itself: no browser was available. The cockpit mode, the sky, the verge colours and the fog distances are untested by eye. The maths (orientation, eye offset, roll direction, verge geometry) is covered by unit tests, and the gains by the capture.
- The cockpit view with banking switched on: the roll now tilts with the surveyed bank, so a banked corner leans the view; the effect is a few degrees at most and was not looked at.
- The 2D, chase, orbit and top views were not looked at after the change (they take the same code path; the scenery is hidden outside the cockpit mode).
- One session on one track and one car (a McLaren 720S GT3 Evo at Spa). The gains for pitch should carry to other cars with different stiffness only roughly.

## Cockpit frame

The cockpit view draws an opaque dark frame over everything outside the windscreen opening (`ribbon/cockpitFrame.ts`). It is a flat mesh fixed to the camera, built in view-direction (tangent) space, so a wider window shows more to the right, as in LMU. The frame is drawn on top (no depth test) just beyond the near plane, shaded from the theme's `cockpitInterior` towards `cockpitTrim`.

- The opening polygon was measured from four of the user's in-game screenshots (vertical FOV 44 deg, 1920x1080) by finding the pixels that are identical across all of them, which are the camera-locked cockpit.
- It is for the McLaren 720S GT3 Evo at the user's seat and FOV. Another car or seat needs its own polygon.
- The opening is the measured part; the trim around it, the bonnet, mirror, displays and wheel are drawn on top of the frame (see The cockpit above). The right pillar is outside the 16:9 view, so the opening runs on to the right.
- Not looked at in a browser.
