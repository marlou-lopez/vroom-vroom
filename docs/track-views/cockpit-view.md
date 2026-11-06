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

## What is missing

- **Slides.** A slide shows in the slip angle, which a recording cannot give; the estimate points the nose along the path. On this lap that is within 1.3 deg 90 % of the time. It would be wrong in a drift or a spin.
- **Road banking on tracks without a survey:** the roll is body roll only there, which is a fraction of what Spa shows (see above). A survey needs no extra driving beyond what the edges need; the bank comes from the same captures.
- **Kerb and bump motion** (the body and eye shake over kerbs, vertical g), steering wheel and hands, the car interior or any dashboard, mirrors, sound.
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

The cockpit view draws an opaque dark frame over everything outside the windscreen opening (`ribbon/cockpitFrame.ts`). It is a flat mesh fixed to the camera, built in view-direction (tangent) space, so a wider window shows more to the right, as in LMU. The frame is drawn on top (no depth test) just beyond the near plane, in the theme's `cockpitInterior` colour.

- The opening polygon was measured from four of the user's in-game screenshots (vertical FOV 44 deg, 1920x1080) by finding the pixels that are identical across all of them, which are the camera-locked cockpit.
- It is for the McLaren 720S GT3 Evo at the user's seat and FOV. Another car or seat needs its own polygon.
- The bonnet, mirror and dash displays are not drawn. The right pillar is outside the 16:9 view, so the opening runs on to the right.
- Not looked at in a browser.
