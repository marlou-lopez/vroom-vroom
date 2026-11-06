# lmu-logger

Records Le Mans Ultimate's shared memory (scoring for every car, session and weather state, and the
player's telemetry) to a compressed file, for later analysis (issue #94). Python standard library only,
Windows only (shared memory is not visible from WSL). The decoder (`decode.py`) also runs on Linux.

A frame is a snapshot of the whole block. LMU's header files that describe its layout say they must
not be redistributed or modified, so nothing from them is in this repo: the logger and the decoder read
the layout from **your own LMU install** at runtime (`layout.py` is a small parser for those headers).

## Setup (once)

```powershell
winget install Python.Python.3.14
```

Python 3.14 or newer is needed (it ships `compression.zstd`). Open a new PowerShell afterwards.

## Run

From the repo folder in WSL, Windows Python can run the script straight from the WSL share:

```powershell
python \\wsl.localhost\<distro>\<path to repo>\tools\lmu-logger\lmu_logger.py
```

Or copy the `tools\lmu-logger` folder to a Windows path and run `python lmu_logger.py` there
(the five files listed below are all it needs; `tests` is optional).

Options: `--out DIR` (default `%USERPROFILE%\vroom-captures`), `--note "Spa, dry, 5 laps"`,
`--lmu-dir DIR`, `--all-cars`.

Needs `lmu_logger.py`, `capture.py`, `winmem.py`, `playerfilter.py` and `layout.py` side by side.

### Player only (default) and `--all-cars`

The block holds one telemetry slot per car, and every slot changes on every update, which is most of
the file size. By default the logger zeroes every telemetry slot except the player's in its copy before
storing it (about 8 microseconds per frame, measured), so the other cars cost almost nothing. The frame
size and file format do not change, so `capture.py` and `decode.py` read these files as before. Scoring
(all cars' positions and lap times), session and weather stay intact. The mode and the slot offsets
used are written into the file header (`mode`: `player_only` or `all_cars`; `capture.py info` shows it).

`--all-cars` records every car's telemetry, the full capture.

To find the slot positions the logger needs LMU's headers at startup. It looks in this order:
`--lmu-dir DIR`, the environment variable `LMU_DIR`, then auto-detect: Steam's install folder (from the
registry value `HKCU\Software\Valve\Steam\SteamPath`, or the default `C:\Program Files (x86)\Steam`),
every library listed in its `steamapps\libraryfolders.vdf` (so a game on `D:` is found), then the default
path. `DIR` is the `Le Mans Ultimate` folder (the one that contains `Support\SharedMemoryInterface`).
It also checks that the layout fits the game's memory region.

**Fallback:** if the headers cannot be found, or the layout does not fit, the logger prints a
`WARNING` that says why and records all cars instead. Pass `--lmu-dir` or set `LMU_DIR` to fix it.

1. Start the logger before or after LMU. It prints "Waiting for Le Mans Ultimate..." until the
   game's shared memory appears.
2. Drive. Turn on LMU's own recording too, so the same laps exist in both files. The logger
   records from the moment it starts (out-lap and pit exit included).
3. Press Ctrl+C to stop. If you close LMU instead, the logger finishes the file and waits for the
   next session, which gets a new file.

A status line every 2 seconds shows frames per second, MB written, compression ratio and the time
since the last update ("LMU idle" if none arrive).

## Files

`<out>\lmu-YYYYMMDD-HHMMSS.lmucap`, one per LMU session. They are git-ignored (`*.lmucap`), but keep
them out of the repo anyway: online sessions contain other drivers' names.

Inspect one (works on any OS, needs Python 3.14):

```
python capture.py info FILE.lmucap
```

`capture.iter_frames(path)` yields `(perf_ns, wall_ns, frame_bytes)` and is what a decoder builds
on. A file cut short by a crash or power loss is still readable up to the last complete record.

**Size** (estimates, from one Spa session with 18 cars): all cars measured 137 MB for 570 s, about
**860 MB per hour**, a 120x compression of the raw frames. Player only: re-encoding that capture with
the other cars' slots zeroed gave 48 MB, about **300 MB per hour** (estimate; a live player-only run
has not been measured). What remains is the player's own telemetry, which changes at about 88 frames per
second, and the scoring of all cars.

## Decoding: `decode.py`

Needs Python 3.14 and your LMU headers (same lookup as above, or `--lmu-dir DIR`; this also works on
Linux/WSL with `LMU_DIR=/mnt/d/Steam/steamapps/common/"Le Mans Ultimate"`).

```
python decode.py layout [FILE]                 # sizes computed from your headers; checks they fit FILE's region
python decode.py player FILE --out player.csv  # one row per distinct telemetry time, the player's car
python decode.py track  FILE --out track.json  # the car's path every 1 m per lap: [x, z, y] (y = height, up)
python decode.py survey FILE [FILE ...] --out survey.json  # track edges, kerbs and wheel-contact edge points (see below)
#   [--half-track M] [--front-z M] [--rear-z M] [--no-fit]
```

- `player`: every scalar of the player's telemetry (vectors as `_x/_y/_z`, arrays with indices, wheels
  as `w0_`..`w3_`) and of the player's scoring entry (prefix `scor_`). The columns come from the parsed
  layout, nothing is hard-coded. Text fields are skipped (so are other drivers' names); the vehicle and
  track name are printed once. About 15 s for 570 s of capture.
- `track`: JSON `{source, track, points: [[x, z, y], ...], laps: [{lap, start_index, end_index (exclusive), lap_time_s}]}`,
  metres rounded to 0.01 m. Resampled every 1 m of horizontal path length, per lap (the pit lane is
  included). `lap_time_s` is only set when the scoring value agrees with the elapsed time. About 11 s.
  This is how `frontend/public/mock/spa-elevation-2026-11-05.json` was made.

- `survey`: JSON `{source, track, captures, edges, kerbs, bank, contacts, wheel_offsets}`, metres rounded to 0.01 m, `side`
  0 = left, 1 = right.
  - `edges: [[x, z, side, half_m], ...]`: LMU's own edge. Every car's scoring entry that is on track (not in the pits or
    garage, `mTrackEdge` not 0) when its values change; thinned across all files to one per side and metre of lap distance
    (`half_m` is the median `|mTrackEdge|`, `x`/`z` the mean scoring position). LMU's edge is the AI path's width per
    waypoint, so it jumps by up to a few metres between waypoints.
  - `kerbs: [[x, z, side, kind], ...]`: every populated telemetry slot's wheels whose terrain name starts with `RMBL`
    (`RMBLFLAT` is `flat`, `RMBLRAZOR` is `razor`, else `other`), at the car's position, with the side of the wheel (FL and
    RL are left), deduplicated on the 1 m cell.
  - `bank: [[x, z, deg], ...]`: the road's banking (#100), for the cockpit camera. Every populated telemetry slot's sample
    (new `mElapsedTime`, per car) with all four wheels on tarmac and not in the pits or garage: roll (asin of the height
    of the orientation's left vector; right side lower is positive) minus `K_ROLL_DEG` (0.476 deg per g, the physical body
    roll, equal to `K_ROLL` in `carAttitude.ts`) times the lateral g (`mLocalAccel` x / 9.80665, positive = left, which
    equals the recording's `g_lat`). Averaged per 4 m world cell, cells with fewer than 3 samples dropped. Cars differ in
    roll stiffness, so slow laps and many cars average toward the road; the Spa file has 5,262 cells.
  - `contacts: [[x, z, kind], ...]`: the physical edge from the wheels (`contacts.py`). Every wheel's terrain name is
    classed as tarmac (`RDRACE*`, `RDPAINT`), kerb (`RMBL*`) or off (anything else); the empty name is unknown and any
    change involving it is ignored. Where a wheel changes class between two consecutive new telemetry samples (new
    `mElapsedTime`, per car) the wheel is on a boundary: `edge` for tarmac to kerb/off or back, `kerb_outer` for kerb to
    off or back. The position is the wheel's world x/z at the midpoint of the two samples: the car's `mPos` plus its
    `mOri` (rows of the vehicle-to-world matrix, vehicle +x = left, +z = back) times the wheel's offset. Samples in the
    pits or garage are skipped, so are jumps over 4 m between samples, and a front and a rear wheel of one side changing
    in the same sample (a teleport). Deduplicated on a 0.25 m world grid per kind, from every populated telemetry slot.
  - `wheel_offsets`: `half_track_m`, `front_z_m`, `rear_z_m` (vehicle z of the axles, negative = forward) and `fit`.
    Wheel positions are not in shared memory, so these are priors for a McLaren 720S GT3 (half-track 0.85 m, wheelbase
    2.70 m, axles at -1.35 and +1.35 m). Unless `--no-fit`, the **wheelbase** is fitted: front and rear wheels of a side
    cross the same edge, and the wheelbase that puts the most front/rear crossing pairs within 0.3 m of each other wins
    (`fit` reports the pairs, residuals before and after, and the wheelbase). Only the wheelbase can be fitted, because
    moving both axles together moves both crossings alike, so the axles keep the prior's midpoint; the half-track cannot
    be fitted either. `--half-track`, `--front-z`, `--rear-z` set the priors (with `--no-fit`, the values used).
  Frames are streamed one at a time, so memory stays modest however long the captures are (the wheel crossings of a
  session are kept until the end for the fit: about 15,000 for the two Spa captures). About 40 s for the two Spa captures.
  How to drive a survey: `docs/track-views/edge-survey.md`. This is how `frontend/public/mock/spa-survey-2026-11-06.json`
  was made.

## Checking the cockpit camera's attitude estimate: `attitude_check.py`

```
python attitude_check.py FILE.lmucap GRID.json [--fit-lap N] [--fixture OUT.json]
```

`GRID.json` is `tools/extract-laps.mjs` run on the same session's recording. Aligns the capture's exact orientation
(`mOri`) to the grid by time and prints the pitch and roll gains fitted on the flying lap, the errors of the estimate in
`frontend/src/lib/carAttitude.ts` per lap, and the slip angle (true yaw minus path heading). `--fixture` writes the flying
lap's inputs and truth (quantised) for `frontend/src/lib/carAttitude.spa.test.ts`. Numbers and method:
`docs/track-views/cockpit-view.md`. Streams the capture (about 20 s for the Spa one).

## What it does not do

- The logger itself does not decode anything; it only needs a few offsets (see above). Pass `--all-cars` for a copy that does not even need those.
- Never writes to the game's memory, never touches LMU's files or recordings.
- Does not take the game's cross-process lock (see below).

## Notes on the mechanism

- Opens the `LMU_Data` mapping read-only and waits for the game's `LMU_Data_HoldEvent` then
  `LMU_Data_DataEvent` (200 ms timeout, so Ctrl+C always works), then copies the region at once.
- The region size comes from `VirtualQuery`, which rounds up to a whole page, so the last few
  bytes may be padding.
- **Torn reads:** the game's interface lets readers take a lock around the copy using an atomic
  compare-and-swap on shared memory. Python has no portable atomic operation, and the Win32
  `InterlockedCompareExchange` is a compiler intrinsic on x64 rather than a `kernel32` export (as
  far as known, not tested). So the logger copies right after the update event, when the game has
  just finished its frame, and a frame could in principle be torn if the game starts the next
  write mid-copy. The copy takes well under a millisecond. Analysis should tolerate the odd
  inconsistent frame.
- File format: see the docstring in `capture.py` (zstd, frame deltas, a keyframe every 300 frames).

## Tests

```
python3 -m unittest discover -s tools/lmu-logger/tests
```
(`python3 -m pytest tools/lmu-logger` also works if pytest is installed.) They run on Linux; the
Windows module is only checked for safe import.
