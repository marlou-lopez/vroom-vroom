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
| SurfaceTypes | 5 | enum per wheel | Values seen: 0, 2, 4, 5, 6. **5 = kerb (rumble strip)**, following the rF2 enum (0 dry, 2 grass, 4 gravel, 6 special). Kerb hits cluster at corner exits. |
| Engine RPM | 100 | rpm | |

## Laps, validity, pits
- **`Lap` event:** `value` = lap number. `ts` = the moment the line is crossed and that lap starts. Lap 0 is the out-lap, starting in the pits.
- **`Lap Time` event:** at each lap start, `value` = the previous lap's time. **0 means invalid** (lap 5 here), and the out-lap gets no entry.
- **Last Sector1 and Last Sector2** are sent at the same `ts`, and are 0 for an invalid lap.
- **`In Pits` event:** 1 = in the pits. Here it is 1 at the session start, 0 at pit exit (49.36 s), and 1 at pit entry (1069.66 s).
- **`Gear` event:** it briefly passes through 0 during each shift (about 0.04 s). Drop a 0 that is followed by another gear within 0.2 s.
- `Current Sector` gives 1 → 2 → 0 (0 = sector 3).
- **Lap times here:** 141.937, 142.139, 141.947, **141.525**, then invalid.

## Metadata
- **Keys:** `Version`, `DriverName`, `SteamID`, `RecordingTime`, `SessionTime`, `SessionType` ("Practice"), `TrackName` and `TrackLayout` (both "Circuit de Spa-Francorchamps"), `WeatherConditions`, `CarName`, `CarClass` ("GT3"), and `CarSetup`.
- **`CarName` is the entry/livery name** ("Garage 59 2026 #58:LM"), not the car model, and no key holds the model. Two liveries of the 720S would therefore count as different cars. → `config/cars.yaml` maps entry names to a model `car_id`.
- **`CarSetup`** is the full garage setup as JSON (172 `VM_*` entries, the same shape as the REST API), which is useful for the setup engineer later.
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
- **Elevation on Spa** (flying lap, in the capture's own coordinates): range 102.3 m. Start/finish 22.3 m, Eau Rouge bottom -1.0 m (about 1005 m into the lap), Raidillon top 25.4 m (about 1305 m), highest 74.5 m on the Kemmel straight (about 2484 m), lowest -27.8 m (about 5021 m). Laps agree on the min and max to about 5 cm.
- **Orientation** is a 3x3 matrix per car next to the position (not yet analysed beyond reading it), and the telemetry also has local velocity, acceleration and rotation rates.
