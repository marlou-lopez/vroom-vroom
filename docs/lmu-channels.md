# Can LMU's recorder log more channels? (vroom-pnw.16, gh-54)

**Question:** can we add channels to `UserData/Telemetry/config.json`, especially yaw rate, tyre slip
(angle or slip velocities), tyre load and local velocity, so oversteer/understeer (vroom-pnw.15) and
lockups can be read directly instead of estimated?

**Answer: no.** The recorder only knows a fixed list of names compiled into the game, and none of these
are on it. Yaw rate, slip velocities and local velocity are in LMU's shared memory (the
`tools/lmu-logger/` route, gh-42 / vroom-7cb.2). Tyre load isn't available on either route: LMU zeroes
it in shared memory. Suspension force is live and can stand in for it.

Checked 2026-11-17 against the LMU build whose exe is dated 2026-09-23, without launching the game.

## What was tried

### 1. The official guide

The "Telemetry Recording" page on guide.lemansultimate.com, as quoted by a search engine because
automated reads are blocked, says: *"You can configure this file in order to remove some
channels/events from the list of recorded data or increase/decrease their frequency."* It mentions
removing channels and changing their frequency, never adding them. The 2026-11-05 search summary said
its example config includes *Yaw Rate* and *Lateral Acceleration*. Neither string exists anywhere in
the game binary (below), so that claim was wrong.

### 2. The names the recorder knows (the game binary)

The recorder is `TelemetryManager` (`Source/Telemetry/Telemetry.cpp`, per the exe's debug strings). It
reads `UserData\Telemetry\config.json` and matches each name against a table compiled into
`Le Mans Ultimate.exe`. The names sit in one run of the exe's string data, between `UserData\Telemetry\`
and the recorder's metadata keys (`SessionType`, `TrackName`, ...), next to its SQL
(`CREATE TABLE channelsList ...`). `tools/lmu-recorder-channels.py` extracts that run and diffs it with
`config.json`:

```
$ python3 -I tools/lmu-recorder-channels.py --check "Yaw Rate" "Tyre Load"
recorder name block: 102 names; config.json: 58 channels, 40 events
config names found elsewhere in the exe (pooled/short strings): ABS, Speed Limiter, TCCut
config names not in the exe at all: TC (expected: TC, a 2-char string)
known to the recorder but not in config.json:
   Air Density, Air Specific Heat, Ambient Pressure, Brakes Core Temp, Humidity, Rain,
   Steering Pos Filtered, Steering Shaft Torque Unfiltered
check 'Yaw Rate': absent
check 'Tyre Load': absent
```

- Every name in config.json is in the exe. Two-character `TC` falls below the scan's
  three-character minimum, and three names were pooled with identical UI strings elsewhere.
- **The recorder knows 8 names that aren't in config.json.** None of them is a yaw, slip, load or
  velocity channel.
- Searching the whole exe (ASCII and UTF-16) for whole-string names finds no `Yaw Rate`, `YawRate`,
  `Lateral Acceleration`, `Slip Angle`, `Tyre/Tire Load`, `TyresLoad`, `Local Velocity`,
  `Lateral Velocity`, `Slip Velocity`, `Wheel Slip`, `Grip Fract` or `Lateral Force`. The `Yaw`,
  `Rotation` and `Camber` strings that do exist belong to the camera, the particle system and the
  physics files. Without a name in the exe there is nothing for config.json to point at.
- `TCSlipAngle` (already a recorded event) is the TC slip-angle *map setting*, not a measured slip
  angle: the exe lists it with `TCLevel` and `TC (Slip Angle)`, the garage setting.

### 3. Recordings match config.json exactly

Read-only copies of 4 recordings (2026-11-05 Monza to 2026-11-17 Bahrain) each have 58 rows in
`channelsList` and 40 in `eventsList`, the same set as config.json. So the recorder writes what
config.json lists, and config.json hasn't changed in that time.

**Does LMU rewrite config.json on launch?** Not an unchanged one: its mtime is still 2026-11-04 01:50,
after more than 240 recordings since. Whether LMU strips or rewrites a file that contains unknown names
is **not tested**.

**Not done: the live test.** The issue planned to edit config.json and drive a session. This worker
has no LMU session (the newest recording was locked by a running game at the time). So no name was
accepted or rejected live. "The recorder knows these 8 extra names" is inferred from the exe, and so is
"a name that isn't in the exe cannot be recorded". The second is a strong inference: the recorder has
no other way to map a name to a value. The live test is filed as a follow-up.

### 4. Shared memory: what is really there (sample values)

From player-only captures of Spa in `tools/lmu-logger/` format, decoded with `decode.py player`, samples
above 20 m/s only. The percentiles come from the 2026-11-05 capture (48,549 samples). The "always 0"
rows hold in that capture and in the 2026-11-06 18:53 one (20,139 samples):

| Field (per wheel `w0..w3` = FL, FR, RL, RR) | Live? | 5th / median / 95th percentile |
|---|---|---|
| `mLocalRot_y` (yaw rate, rad/s) | yes | −0.386 / 0.026 / 0.482 |
| `mLocalVel_x/y/z` (m/s, car axes) | yes | forward is −z |
| `wN_mLateralGroundVel`, `wN_mLongitudinalGroundVel` | yes | front slip angle `atan2(lat, abs(long))`: −3.4 / 0.1 / 4.2°; rear −1.8 / 0.1 / 2.1° |
| `wN_mLateralPatchVel`, `wN_mLongitudinalPatchVel` (m/s) | yes | FL lateral −1.5 / 0.0 / 0.6 |
| `wN_mSuspForce` (N) | yes | FL 1,767 / 5,788 / 8,550; RL 3,450 / 7,873 / 11,094 |
| `wN_mVerticalTireDeflection` (m) | yes | FL 0.006 / 0.019 / 0.029 |
| `wN_mTireLoad`, `wN_mGripFract`, `wN_mLateralForce`, `wN_mLongitudinalForce` | **always 0** | |
| `mFrontRideHeight`, `mRearRideHeight`, `mFrontDownforce`, `mRearDownforce`, `mDrag` | **always 0** | (the recording's `FrontRideHeight` is live) |

- **Yaw rate sign (empirical):** `mLocalRot_y` correlates +0.944 with `mUnfilteredSteering` (2026-11-05;
  +0.965 on 2026-11-06) and −0.94 with `mLocalAccel_x` (+x is left) in both captures. So `mLocalRot_y > 0` is a right turn, the same sense as positive
  steering. The derived slip angles are given as computed; their sign convention hasn't been checked.
- LMU deliberately blanks tyre load, tyre forces, grip fraction, downforce and the car-level ride
  heights in shared memory (the same in both captures). The recorder has access to more than the
  public block does (its ride-height channels are live), but it exposes no load channel either.

## Options

1. **Leave the recorder alone; read yaw rate and slip from shared memory (recommended).** The
   `lmu-logger` already records them at 100 Hz alongside the `.duckdb`. A backend importer could join a
   capture to its recording by elapsed time (the clocks are identical, see `lmu-duckdb-schema.md`), and
   the v3 Windows agent (vroom-7cb.2) reads the same block live. For load, use `mSuspForce` (or
   vertical tyre deflection) as a proxy. Cost: the logger has to run, so older recordings get none of it.
2. **Estimate from the recording alone.** Yaw rate ≈ −9.81·`g_lat`/speed in rad/s (`g_lat` is in g and positive in a left turn, while
   `mLocalRot_y` is positive in a right turn), or the GPS heading rate, and slip as
   in `docs/track-views/cockpit-view.md` (median 0.31° yaw-vs-path difference). Works for every
   recording, but it's an estimate. This is what vroom-pnw.15 has to fall back on anyway.
3. **Also add the 8 extra names to config.json** (`Brakes Core Temp`, `Steering Shaft Torque
   Unfiltered`, `Steering Pos Filtered`, the weather events). Cheap, but not verified live, and none of
   them helps coaching. Worth it only if a setup or brake feature (v5) asks for core temperature.

**Recommendation:** option 1 for yaw rate and slip, with option 2 as the fallback when no capture
exists. Don't build anything on config.json channels that don't already exist.

## Re-checking after an LMU update

Run `python3 -I tools/lmu-recorder-channels.py`. If it reports "recorder strings not found", the exe
layout changed: update `START`/`END` in the script.
