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
| Throttle Pos / Brake Pos | 50 | % (0–100) | Divide by 100. |
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
