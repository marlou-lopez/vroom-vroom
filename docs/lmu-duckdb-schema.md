# LMU DuckDB telemetry: findings

Source: `Circuit de Spa-Francorchamps_P_2026-11-03T17_53_46Z.duckdb`. It is 24 MB and covers about 18 minutes: out-lap, 4 flying laps, 1 invalid lap and an in-lap. The car is the McLaren 720S GT3 Evo, entry "Garage 59 2026 #58:LM". The recording config had `Lap Dist`, the G channels and GPS raised to 50 Hz. I inspected the file read-only, from a copy, on 2026-11-04.

These findings answer plan Task 1 Step 8. **Where they contradict the plan, the plan has been updated.**

## Layout
- The file has 101 tables: one per channel or event, plus the registries `channelsList(channelName, frequency, unit)`, `eventsList(eventName, unit)` and `metadata(key, value)`.
- **Continuous channels** have no timestamp column. They have `value`, or `value1..value4` for per-wheel channels in FL, FR, RL, RR order (the order is assumed and still unverified).
  - The sample time is `t = t0 + i / frequency`, where `t0 = min("GPS Time".value)`. In this file `t0` = 22.975 s.
  - Verified with row counts: `GPS Time` has 108001 rows at 100 Hz, spanning 1079.997 s, and every 50 Hz channel has 54001 rows.
- **Events** are `(ts DOUBLE, value)` and are emitted on change. `ts` is on the same clock as `GPS Time`.

## Units and conventions (check against `channelsList.unit`)
| Channel | Rate | Unit | Notes |
|---|---|---|---|
| Ground Speed | 100 | km/h | |
| Throttle Pos / Brake Pos | 50 | % (0–100) | Divide by 100. **Use `Throttle Pos Unfiltered` for the driver's throttle:** `Throttle Pos` is the throttle after the game's interventions: it drops to 0 at every upshift (ignition cut) while the pedal stays down (all 18 upshifts on lap 4), and can read lower elsewhere too (0.66 vs a 0.99 pedal mid-Bus Stop; cause unverified, possibly TC). The two differ on 286 of 7,076 samples on lap 4. `Brake Pos` and `Steering Pos` equal their `Unfiltered` channels on that lap. |
| Steering Pos | 100 | % (−100..100) | **+ = right.** Divide by 100 for normalised steering. |
| Lap Dist | 50 | m | Resets to 0 at the line. The first samples of a lap can still show the previous lap's distance (about 6979). |
| GPS Latitude / Longitude | 50 | deg | **Not real-world coordinates**: about 60.0 N, 0.0 E for Spa. It is a local projection; equirectangular with cos(lat) gives the true shape (one lap's GPS path is 6998 m, against 6979 m of lap distance). |
| **G Force Lat** | 50 | G | **Actually longitudinal.** Positive under braking (+1.6 g into La Source). |
| **G Force Long** | 50 | G | **Actually lateral.** Negative in right-handers, positive in left-handers (Pouhon +1.8 g). |
| Path Lateral / Track Edge | 10 | m | **Path Lateral** = metres from the track centreline, **+ = right of travel** (verified 2026-11-05: the centreline implied by laps 1-4 agrees to 0.05 m rms across the track (0.09 m as 2D distance) with this sign, 1.19 m with the opposite). **Track Edge** = distance from the centre to the edge **on the car's side**, with the sign of that side (flips when Path Lateral crosses 0). |
| SurfaceTypes | 5 | enum per wheel | Values seen: 0, 2, 4, 5, 6. **6 = flat kerb** (`RMBLFLAT` in shared memory), **5 = razor kerb** (`RMBLRAZOR`) but also drains and concrete edges (`COBL,DRAIN`, `CRETE`), so a type-5 hit is not always a kerb (the recording has no terrain names to tell). Others follow the rF2 enum (0 dry, 2 grass, 4 gravel). Verified 2026-11-06 against the per-wheel terrain names. On one Spa flying lap, wheels touched flat kerbs in 71 ten-metre stretches and type 5 in 33. Kerb hits cluster at corner exits. |
| ABS / TC | event / 100 | bool | **ABS** is an event table (`ts`, `value`) that pulses on and off about every 10-15 ms while active (1,601 on-pulses on the Spa recording). **TC** is a 100 Hz channel (2,803 of 108,001 samples on). `ABSLevel`, `TCLevel`, `TCCut` and `TCSlipAngle` events hold the settings. Grid: `abs` / `tc` are 1 when any on-sample falls inside that metre (verified 2026-11-17 on Spa: lap 4 has 315 m of ABS and 182 m of TC). |
| Wheels off track | derived | 0-4 | **Inferred, not verified in game.** Off track = a wheel's `SurfaceTypes` value is 2 (grass) or 4 (gravel), from the rF2 enum; 0 is tarmac and 5 / 6 are kerbs (verified, #97), which count as on track. Grid channel `wheels_off` = the number of such wheels, resampled **stepwise** (the latest 5 Hz sample at or before each metre, never interpolated; `tools/surface-resample.mjs`). Verified 2026-11-17 on Spa: lap 5 (invalid) has 466 m with two or more wheels off, spread over 334-5208 m; valid laps 1, 3 and 4 have one or two short stretches (23-45 m) and lap 2 none. LMU's real track-limit rule (white line, number of wheels, kerb exceptions) is not documented, so the app only says "likely". |
| Wheel Speed | 100 | m/s | Four values (FL, FR, RL, RR assumed). Slip ratio = wheel speed / (Ground Speed / 3.6); the grid writes it as `slip_*`, and 1 below 5 m/s. On Spa lap 4 the lowest slip under braking is 0.97 and the highest on throttle 1.05, so no lockup or wheelspin there; lap 5 (invalid) has a real lockup (0.85, front wheels) and a spin (1.105, rear). Thresholds 0.9 / 1.1 are first guesses (#25). Corners and the pit lane do not need a correction: a wheel's speed differs from the ground speed by under 1 % from yaw alone. |
| Engine RPM | 100 | rpm | |
| Susp Pos / RideHeights | 100 | unit unchecked | Four values per sample, wheel order assumed FL, FR, RL, RR. Not in the extractor's grid yet. Checked 2026-11-06 against the capture's body orientation (Spa flying lap): front minus rear ride height predicts body pitch to 0.03 deg median (slope removed), but left minus right suspension does **not** predict body roll (0.76 deg median against 0.86 for lateral g alone), because the road's own banking rolls the body without moving the suspension. |

## Laps, validity, pits
- **`Lap` event:** `value` = lap number. `ts` = the moment the line is crossed and that lap starts. Lap 0 is the out-lap, starting in the pits.
- **`Lap Time` event:** at each lap start, `value` = the previous lap's time. **0 means invalid** (lap 5 here), and the out-lap gets no entry.
- **Last Sector1 and Last Sector2** are sent at the same `ts` as the `Lap Time` of the lap they belong to (the next lap's start), and are 0 for an invalid lap. **Last Sector1 is sector 1's time; Last Sector2 is cumulative** (S1 + S2, as in rF2), so sector 2 = Sector2 − Sector1 and sector 3 = Lap Time − Sector2 (verified 2026-11-17: Spa lap 4 gives 38.267 + 63.529 + 39.728 = 141.525 = its Lap Time). On Monza an in-lap boundary can carry a Sector1 with no Sector2; take sectors only when Lap Time > 0 and 0 < Sector1 < Sector2 < Lap Time. `tools/extract-laps.mjs` writes `sectors_s` [S1, S2, S3] per lap (null otherwise).
- **No invalidation event (checked 2026-11-17, Spa and Monza):** `eventsList` has no track-limit, penalty or lap-invalidated event. The closest are `Lap Time` = 0 (which only says *that* the lap is invalid, at the next lap start), `Finish Status`, `Yellow Flag State`, `WheelsDetached` and `LastImpactMagnitude`, none of which mark a track-limit breach. So where a lap was invalidated can only be guessed from the wheels' surfaces (`wheels_off`, below).
- **`In Pits` event:** 1 = in the pits. Here it is 1 at the session start, 0 at pit exit (49.36 s), and 1 at pit entry (1069.66 s).
- **`Gear` event:** it briefly passes through 0 during each shift (about 0.04 s). Drop a 0 that is followed by another gear within 0.2 s.
- `Current Sector` gives 1 → 2 → 0 (0 = sector 3).
- **Lap times here:** 141.937, 142.139, 141.947, **141.525**, then invalid.

## Metadata
- **Keys:** `Version`, `DriverName`, `SteamID`, `RecordingTime`, `SessionTime`, `SessionType` ("Practice"), `TrackName` and `TrackLayout` (both "Circuit de Spa-Francorchamps"), `WeatherConditions`, `CarName`, `CarClass` ("GT3"), and `CarSetup`.
- **`CarName` is the entry/livery name** ("Garage 59 2026 #58:LM"), not the car model, and no key holds the model. Two liveries of the 720S would therefore count as different cars. → `config/cars.yaml` maps entry names to a model `car_id`.
- **`CarSetup`** is the full garage setup as JSON (172 `VM_*` entries, the same shape as the REST API), which is useful for the setup engineer later.
  - **Shape:** an object keyed by setting id, 170 entries on the 720S GT3: `VM_*` for the car and `WM_<item>-W_<FL|FR|RL|RR>` per wheel, plus two non-setting keys (`gearGraph`, `symmetric`) with no `stringValue`. Each setting has `stringValue` (the display string, e.g. "6.7 deg"; `value` is an index), `lastSavedStringValue`, `minValue`, `maxValue`, `diffComparisonValue` and sometimes `caption`. `tools/extract-laps.mjs` keeps only key -> `stringValue` as `car_setup` (checked: no driver name or account id inside; those are separate metadata keys). The mock serves it at `GET /api/sessions/{id}/setup` (vroom-pnw.25).
  - **Unverified:** whether `CarSetup` is the setup at the start or the end of the recording when the setup is changed in the garage mid-session (`stringValue` differs from `lastSavedStringValue` on 47 settings in the Spa file, so it is the live setup, not the saved one). Treat it as per session, not per lap, until checked on a recording with a mid-session change.
  - **The steering range is `VM_STEER_LOCK.stringValue`**, "524deg (18.5deg)", so `steering_range_deg = 524`. Parse the leading number.

## Rates and size
- Recording at 100 Hz for most channels, with 6 channels raised to 50 Hz, gives about 24 MB for 18 minutes.

## Grid resampling sanity check
- Distance is resampled from `Lap Dist` at 50 Hz, after fixing the start-of-lap wrap. Grid `t` at the end of each lap matches the official lap time to within 0.04 s.
- Speed integration gives 6956 m, against 6979 m of lap distance (0.3 % short). That is fine for the fusion fit.
- Extractor used for the mock data: `tools/extract-laps.mjs` (Node, `@duckdb/node-api`).

## Shared memory (verified 2026-11-05)

The `.duckdb` recordings have no elevation, world position or orientation, but LMU's shared memory does. Verified on a Spa capture (570 s, McLaren, 18 cars in the session) made with `tools/lmu-logger/`, recorded alongside the same session's `.duckdb`. The layout itself is read from the user's own LMU headers at runtime (`tools/lmu-logger/layout.py`); no struct tables are kept in this repo (the headers' licence forbids copying them).

- **How to reach it:** a named file mapping `LMU_Data`, plus two named events, `LMU_Data_HoldEvent` and `LMU_Data_DataEvent`, that mark a new frame. It is only visible from Windows (not from WSL). The mapped region is 327,680 bytes, which is the 324,824-byte block rounded up to whole pages.
- **What is in it:** telemetry slots for up to 104 cars (the player's index is stored next to them), scoring for every car (lap number, lap distance, last lap time, positions), session, rules, weather and app state. In the 18-car session every car's telemetry slot changed on every frame.
- **Update rate:** the player's telemetry changes at 100 Hz. Frames arrive at about 88 per second and some repeat the previous sample, so de-duplicate by the telemetry elapsed time (50,204 frames gave 48,549 distinct samples in 570 s).
- **Lap numbering:** in telemetry the out-lap is lap 0 and the first flying lap is 1, which matches the `Lap` event of the recording. The scoring entry's completed-lap count and last lap time lag the telemetry lap counter, and the last lap time reads -1 for a moment around the line. So a lap's time is only trustworthy once the next lap is running.
- **Lap time equals the recording's:** the recording's `Lap Time` event (143.77989196777344 s at the start of lap 2 in that session) equals the shared-memory last lap time bit for bit.
- **Same clock:** the recording's event timestamps equal the game's elapsed time in telemetry (lap 2 started at 336.60 s in both).
- **World position:** the player's position is three doubles in metres. **+y is up**, so `y` is elevation. x and z are the horizontal plane.
- **GPS is a fixed transform of the world position** (verified on Spa only). With R = 6371008.8 m: `lat = 60 + z / (R·π/180)` and `lon = x / (R·π/180·cos 60°)`, so `x = lon · R·π/180·cos 60°` and `z = (lat − 60) · R·π/180`. The residual is 0.16 m rms, which is the recording's float32 GPS. An older recording can therefore get heights from one captured lap of the same track.
- **Elevation on Spa** (flying lap, in the capture's own coordinates): range 102.3 m. Start/finish 22.3 m, Eau Rouge valley floor -5.0 m (about 926 m into the lap), top of Raidillon 30.3 m (about 1399 m), highest 74.5 m on the Kemmel straight (about 2484 m), lowest -27.8 m (about 5021 m). Laps agree on the min and max to about 5 cm.
- **Orientation** `mOri[3]` are the rows of the vehicle-to-world matrix: `world_r = mOri[r] . local`. Vehicle axes: +x out of the left side, +y up, +z out of the back (forward is -z). Verified 2026-11-06 on 52,000 samples above 20 m/s: `mOri x (0, 0, -1)` has a dot product of 1.0000 with the direction of travel (the transposed reading gives a median of 0.43), and `mOri x (1, 0, 0)` points along forward x up (0.9987), i.e. to the left in the left-handed y-up world. The telemetry also has local velocity, acceleration and rotation rates.
- **Per-wheel surface (verified 2026-11-06):** every wheel has a terrain name (`mTerrainName`, 16 chars) and a surface type at 100 Hz, for every car in an all-cars capture (in a player-only capture only the player's slot is filled). Names seen on Spa: `RDRACEOLD,ROAD,` (road), `RMBLFLAT` (type 6, flat kerb), `RMBLRAZOR` (type 5, razor kerb), `COBL,DRAIN` and `CRETE` (type 5, not kerbs), `RDCP,CONC`, `RDRUNOFF`, `RDPAINT` (white line), `GRVL`. Wheel order is FL, FR, RL, RR. Wheel positions are not in shared memory, only the car's.
- **Yaw rate, slip and load (verified 2026-11-17, two Spa captures; vroom-pnw.16):** `mLocalRot_y` is the yaw rate in rad/s, positive in a right turn (it correlates +0.94 to +0.97 with `mUnfilteredSteering` and −0.94 with `mLocalAccel_x`). Per-wheel `mLateralGroundVel`/`mLongitudinalGroundVel` and `mLateralPatchVel`/`mLongitudinalPatchVel` are live, as are `mSuspForce` and `mVerticalTireDeflection`. **Always 0 in LMU:** `mTireLoad`, `mGripFract`, the tyre `mLateralForce`/`mLongitudinalForce`, `mFrontRideHeight`, `mRearRideHeight`, `mFrontDownforce`, `mRearDownforce`, `mDrag`. Use `mSuspForce` as the load proxy. Sample values: `docs/lmu-channels.md`.
- **Track edge in scoring:** `mTrackEdge` (5 Hz, per car) is the distance to the track edge on the side the car is on (negative = left), measured from LMU's centre path, which is not the middle of the road and can sit about 2 m off it. See `docs/track-views/edge-survey.md`.

- **Physics-to-graphics offset (verified 2026-11-06, Spa, McLaren 720S GT3 Evo):** telemetry `mPhysicsToGraphicsOffset[3]` ("offset from static CG to graphical center", vehicle axes +x left, +y up, +z back) is (0, -0.3335, -0.0745) m for the player's car, identical in every sample of four captures. The recorded position (`mPos`, and so the recording's GPS) is the physics point; the visual centre is 7.45 cm ahead of and 33.35 cm below it. See `docs/track-views/cockpit-view.md`.
- **LMU's field-of-view setting:** `UserData/player/Settings.JSON` in the LMU install has `"Vertical FOV Degrees": 44` (comment: "9=use default, otherwise is the FOV for attached cameras (horiz is calculated based on aspect ratio)"). It is the vertical FOV, 44 on the user's setup. The cockpit view mirrors it (`COCKPIT_FOV`).

## Car attitude from the recording (verified 2026-11-06, Spa)
The recording has no orientation, but the capture's `mOri` of the same session gives the truth to compare with. With the grid channels: `g_lat > 0` is a left turn (it follows the centripetal acceleration `v²·curvature` with a correlation of 0.99, and has no road-banking component, so it cannot tell the banking), `g_long > 0` is braking. The car's yaw differs from the GPS path heading by 0.31 deg at the median and 1.26 deg at the 90th percentile on the flying lap (the slip angle). Pitch and roll fits, errors and the banking finding: `docs/track-views/cockpit-view.md`.

## Which channels the recorder can log (verified 2026-11-17; vroom-pnw.16)
The recorder records exactly the channels and events listed in `UserData/Telemetry/config.json` (58 channels and 40 events here; LMU leaves an unchanged file alone on launch, and whether it strips unknown names is untested). It can only record names in a table compiled into the exe (inferred from the binary; no live config edit was tested): `tools/lmu-recorder-channels.py` lists them. Besides the default config, it knows only `Brakes Core Temp`, `Steering Shaft Torque Unfiltered`, `Steering Pos Filtered`, `Air Density`, `Air Specific Heat`, `Ambient Pressure`, `Humidity` and `Rain` (not tested live). There's no yaw rate, slip, tyre load or local velocity channel; those come from shared memory (above). The `TCSlipAngle` event is the TC slip-angle map setting, not a measured slip angle. Details: `docs/lmu-channels.md`.

## Stint channels: fuel, virtual energy, tyres, brakes, weather (verified 2026-11-17, vroom-pnw.26)

Source: a survey of 244 recordings (copies, read-only) and two in detail: `Autodromo Nazionale Monza_R_2026-11-09T11_57_06Z` (race, 26 laps, McLaren 720S GT3 Evo #10, "Light Clouds") and `Circuit de Spa-Francorchamps_P_2026-11-05T10_19_08Z` (practice, Ferrari 499P Hypercar, one invalid lap). **Every recording has the same 58 channels and 40 events**, whatever the car class, because the recorder logs what `UserData/Telemetry/config.json` lists. Write-up: `docs/stint/stint-view.md`.

| Channel | Rate | Unit (recorded) | Notes |
|---|---|---|---|
| Fuel Level | 20 | L | Litres in the tank. Monza race: 85.0 at the start, about 3.05 L a flying lap, 8.2 L at the stop; it rises during the stop (refuelling is visible). |
| **Virtual Energy** | 20 | % | Percent of the virtual energy allocation left. **Recorded for GT3 too** (LMU applies the WEC energy rules to LMGT3): 100 → 5.1 % over the Monza race, about 3.8 % a flying lap, so energy runs out before fuel (26.3 laps of energy against 27.8 of fuel). Hypercar: 100 → 93.4 % on the out-lap and part of a lap. |
| SoC | 20 | % | Hybrid battery state of charge. 0 throughout on the GT3; on the Hypercar it cycles between 3 and 100 % within a lap. |
| Regen Rate | 100 | kW (recorded) | **The values are watts**, not kW: −117,538 to 193,617 on the Hypercar (deploy is negative). 0 on the GT3. |
| Tyres Wear | 10 | % | Four values, **tread left** (100 = new). Monza race: FL 97.6 → 86.9 over 25 laps, the most-worn tyre (about 0.44 % a lap; the others about 0.36). |
| TyresTempLeft / Centre / Right | 100 | C | The three tread zones. **Left and Right are the car's left and right edges** of each tyre: on the left tyres the right (inner) edge is hottest and on the right tyres the left (inner) edge, as negative camber gives (Monza lap 5: FL 75 / 84 / 85, FR 79 / 76 / 67). |
| TyresCarcassTemp | 5 | C | About 3 °C above the surface mean on the Monza race. |
| TyresRubberTemp | 10 | C | Close to the centre tread temperature. |
| TyresRimTemp | 50 | C | 74–82 °C on the Monza race, 54–60 °C on the Hypercar out-lap. |
| TyresPressure | 10 | kPa | Monza race laps: about 166–173 kPa hot. |
| Brakes Temp | 50 | C | Disc temperature. Monza race: lap means about 470 °C front and 370 °C rear early in the race, about 370–400 front and 290–315 rear late in it (lighter car, as fuel burns off); peaks about 740 °C front. |
| Brakes Air Temp, Brakes Force | 50 | C, % | Not used yet. |
| Brake Thickness | 10 | % (recorded) | Values look like **centimetres** of disc: 3.6 front and 3.2 rear on the GT3, 3.4 and 3.2 on the Hypercar; 0.008 worn over the 50-minute race. |
| OverheatingState | 2 | bool | False throughout both files. |
| Track Temperature, Ambient Temperature | 1 | C | Monza race: track 35.3 → 37.6 °C, air about 18 °C. |
| Wind Speed, Wind Heading | 1 | m/s, deg | |
| Engine Oil Temp, Engine Water Temp | 7 | C | |

**Events:** `TyresCompound` (four values, one per wheel; 0 on the GT3, 1 on the Hypercar; names unverified), `FuelMixtureMap` (1 on the GT3, 6 on the Hypercar), `Minimum Path Wetness` and `OffpathWetness` (%; 0 / false on dry days), `CloudDarkness`. Events are emitted on change, so a dry session has one row each.

**Wheel order FL, FR, RL, RR is confirmed** by these channels on the right-handed Monza: value1 and value3 (the left tyres) run 4–8 °C hotter than value2 and value4, and value1 and value2 (the fronts) carry the hotter brakes.

**A pit stop in a race:** `In Pits` goes to 1 during the last lap before the stop (that lap still gets a `Lap Time`, the pit-lane time included, 119.9 s here); the next lap starts in the pits. Lap 0 of a race is the start lap (125.2 s from the start, against 113 s for a flying lap).
