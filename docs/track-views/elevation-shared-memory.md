# Elevation from LMU shared memory (#94)

**Question:** LMU's recordings have no elevation, world position or orientation. Does the game's shared memory, read by a small standalone logger, give a usable 3D shape of a track (about 100 m of range at Spa, laps agreeing to about 0.1 m), and can older recordings get it too?

**Status:** spike. The prototype is in the app: an **ELEVATION** strip (marked *exp*) under the other telemetry strips whenever the compared track has a capture. **Decision: pending the user's keep / change / drop.**

## What was built

- **Logger** (`tools/lmu-logger/lmu_logger.py`, Windows, Python 3.14, standard library only). It copies the whole shared-memory block on every game update and stores it as a zstd delta against the previous frame in a `.lmucap` file. Frames are whole-block snapshots. By default the logger blanks the other cars' telemetry slots first (offsets from `layout.py`; `--all-cars` keeps them), which keeps the format unchanged. One command to run; the README covers setup.
- **Layout from the user's own headers** (`layout.py`). LMU's headers describe the block but their licence forbids copying them, so nothing from them is in the repo. `layout.py` is a small C++ declaration parser (packing, enums, unions, arrays, nested structs, base classes, skipping methods) that computes sizes and offsets from the installed headers at runtime.
- **Decoder** (`decode.py`): `layout` prints the computed sizes, `player` writes a CSV with one row per distinct telemetry time for the player's car (349 columns, all scalars of the car's telemetry and scoring entry, wheels as `w0_..w3_`), and `track` writes the car's path resampled every metre per lap as `[x, z, y]`.
- **Frontend:** `public/mock/spa-elevation-2026-11-05.json` (the `track` output), `src/lib/elevation.ts` (lat/lon to world x/z with the GPS transform, nearest-segment lookup on a 10 m grid, null beyond 5 m), `CompareResponse.elevation` in the API contract, the mock filling it for Spa laps (null for Monza), and the strip.

## Results

Capture: Spa, 570 s, 50,204 frames, 18 cars in the session. Out-lap 0, flying lap 1 (143.7799 s), in-lap 2.

**The layout parser reproduces the sizes computed independently with a C++ compiler:** `TelemInfoV01` 1888 bytes, `VehicleScoringInfoV01` 584 bytes, the whole block 324,824 bytes, with telemetry at 128,464 and scoring at 1,632 in the block; the offsets of the elapsed time (12), lap number (20), position (160), lap distance (104) and player flag (196) match too. The block fits the capture's 327,680-byte region. Parsing the three headers takes 0.07 s.

**Facts verified** (full list in `docs/lmu-duckdb-schema.md`, "Shared memory"):
- Player telemetry updates at 100 Hz; lap 0 is the out-lap, like the recording.
- The recording's `Lap Time` equals the shared-memory last lap time bit for bit, and the recording's clock is the game's elapsed time. So the logger laps and the `.duckdb` laps match exactly, with zero clock offset.
- The recording's GPS is a fixed transform of the world x/z: `lat = 60 + z/(R·π/180)`, `lon = x/(R·π/180·cos 60°)`, R = 6371008.8 m, residual 0.16 m rms (just the float32 GPS). Verified on Spa only.
- **y is up, in metres.**

**Elevation against the target** (Spa flying lap): range 102.3 m. Start/finish 22.3 m; La Source down to Eau Rouge bottom -1.0 m (about 1005 m in); Raidillon top 25.4 m (about 1305 m); highest 74.5 m at about 2484 m (Kemmel); lowest -27.8 m at about 5021 m. The laps agree on min and max to about 5 cm, so the "within about 0.1 m" target is met on the extremes.

**Attached to an older recording through GPS.** The mock's laps come from a different recording (3 Nov) than the capture (5 Nov). Matching them only by GPS, with a nearest-point lookup within 5 m:
- Flying laps 1-4 of the 3 Nov recording: 100.00 % of grid points get a height (6,979 or 6,980 per lap). Out-lap 100 %, in-lap 99.8 %, the invalid lap 91.2 % (it leaves the track).
- Eau Rouge bottom -1.00, -0.95, -1.01, -0.99 m and Raidillon top 25.38-25.39 m on the four flying laps, highest 74.5 m and lowest -27.9 m: the same figures as in the capture.
- The four mock flying laps differ from each other by 1.4 cm (median), 14 cm (99th percentile) and 24 cm at most, per grid point.

**Sizes and timings:**
- Capture of 570 s: 137 MB, 120x smaller than the raw frames. That is about 860 MB per hour with 18 cars, because every car's telemetry slot changes on every frame. Blanking the other cars' slots in a re-encode of the same capture: 48 MB (about 306 MB per hour), costing 8 microseconds per frame.
- Reading the capture takes about 11 s (decompression and delta decoding); `decode.py track` in 11.3 s and `decode.py player` (48,549 rows x 349 columns, 186 MB of CSV) in 15 s.
- The elevation file is 473 KB (20,825 points over three laps, rounded to 0.01 m); it is fetched once by the mock.

## Known limits

- **Torn reads:** the logger does not take the game's lock (Python has no portable atomic compare-and-swap), so a frame could be read while the game starts writing the next one. None was noticed in this capture, but the decoder does not detect them.
- **The GPS formula is verified on Spa only.** The constants (origin 60 N, 0 E, the radius) may differ per track; check on the next track before relying on it.
- **Size:** about 860 MB per hour of capture while 18 cars are active (the capture above was made with all cars recorded). The logger now records the player only by default; re-encoding this capture with the other cars' slots blanked gave 48 MB for 570 s, about 306 MB per hour (estimate; the remaining size is the player's own telemetry changing at ~88 frames per second and the scoring of all cars). A live player-only run has not been measured.
- Heights are the game's world heights: relative within a track, not metres above sea level.
- The prototype uses one capture; a pit-lane or run-off path is only covered where the capture drove.

## Recommendation

**Keep.** One captured lap gives the game's own 3D shape, accurate to centimetres, and old recordings can use it through GPS.
- **#37 (terrain fitting from public data) is no longer needed** as the route to elevation.
- **Next:** the backend computes per-track elevation from captures (#38 / #41), so the import step can attach heights to any recording of a captured track. A capture per track is still needed once; the logger runs while driving with LMU's own recording on.
- **#39 (3D ribbon)** can use the captured heights, and a cockpit camera can use the orientation matrix next to the position.
- #42 (the Windows agent) can reuse the logger's reader and the layout parser.

## Decision

**Keep** (2026-11-05), recorded on #94. #37 (terrain fitting) closed as not planned. The build work (per-track elevation computed from captures and served as track geometry) goes into #38 and #41.
