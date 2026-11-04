# Per-lap racing lines (#34)

**Question:** can each lap be drawn on its own path, about 1 m accurate, instead of both cars sharing one smoothed line? Which reconstruction should we use?

**Status:** spike. The prototype is in the app under *2D detailed* (experimental): **Line: Shared · GPS · Lateral** and **Cars: Time · Distance**. **Decision (2026-11-05): keep, as recommended below.**

## Data facts this relies on

These were verified on the Spa recording, 2026-11-03, laps 1–4, and are also in `docs/lmu-duckdb-schema.md`.
- **GPS** is LMU-local and float32: about 0.4 m steps north–south. Equirectangular projection with cos(lat) gives local metres.
- **`path_lateral` is metres from the track centreline, + = right of travel.**
  - With that sign, the centreline implied by four laps (GPS point + `path_lateral` × left normal) agrees across laps to 0.05 m rms across the track, or 0.09 m as 2D distance.
  - With the opposite sign it's 1.19 m.
- **`path_lateral` is recorded at 10 Hz.** On the 1 m grid that's one sample every ~2 m at 70 km/h and ~7 m at 250 km/h, linearly interpolated.
- **No world-position or heading channel exists**, so there's no ground truth. Agreement between independent methods, and lap-to-lap repeatability, stand in for it.

## Methods

Code: `frontend/src/lib/racingLine.ts`.

1. **GPS:** each lap's own GPS, smoothed with a closed-loop moving average of ±h m (h = 0, 2, 4, 8).
2. **Lateral:** a centreline shared by the compared laps, plus each lap's `path_lateral` along the centreline's normal.
   - Centreline: start from the laps' mean GPS (smoothed ±15 m), then twice average `p + pl·n` over the laps and smooth ±4 m.
   - `path_lateral` is smoothed ±4 m, skipping samples beyond 15 m.
   - Normals are taken from a ±10 m chord.
   - Where |`path_lateral`| > 15 m (off track), the GPS ±4 m point is used instead.

**Shared** is the old behaviour (the reference lap's GPS smoothed ±8 m, both cars on it), kept for comparison.

**Car placement:**
- **Time-synced:** each car sits at its own distance at the playhead. The gap between them shows the time delta as a distance.
- **Distance-synced:** both cars sit at the same track distance, so the lines can be compared side by side.

## Results

From `racingLine.spa.test.ts` on Spa laps 1–4. "Straights" are 1,394 of the 6,979 grid points, at least 50 m from any corner, in runs of 200 m or more.

**Agreement between the two methods** (GPS ±4 vs Lateral, per lap; metres, mean / p95 / max):

| lap | whole lap | straights | Eau Rouge–Raidillon (707–1158 m) | Bus Stop (6409–6819 m) |
|---|---|---|---|---|
| 1 | 0.03 / 0.09 / 0.28 | 0.03 / 0.07 / 0.17 | 0.02 / 0.06 / 0.09 | 0.04 / 0.11 / 0.15 |
| 2 | 0.03 / 0.09 / 0.25 | 0.03 / 0.09 / 0.15 | 0.03 / 0.07 / 0.12 | 0.04 / 0.12 / 0.16 |
| 3 | 0.03 / 0.09 / 0.72 | 0.03 / 0.08 / 0.19 | 0.03 / 0.07 / 0.10 | 0.04 / 0.13 / 0.16 |
| 4 | 0.03 / 0.09 / 0.52 | 0.03 / 0.08 / 0.20 | 0.03 / 0.07 / 0.21 | 0.04 / 0.13 / 0.17 |

How much GPS smoothing matters (same comparison):
- **±0:** 0.09 m mean. The 0.4 m quantisation shows through.
- **±2:** 0.04–0.05 m mean.
- **±4:** 0.03 m mean, the best match.
- **±8:** 0.05 m mean, and it shrinks Bus Stop (p95 0.32–0.34 m).

**Repeatability on straights:** the spread (max − min) of the four laps' lateral offsets at each point.

| method | mean | p95 | max |
|---|---|---|---|
| GPS ±0 / ±2 / ±4 / ±8 | 1.58 / 1.58 / 1.58 / 1.57 | 2.57 / 2.56 / 2.56 / 2.53 | 3.17 / 3.13 / 3.11 / 3.10 |
| Lateral | 1.58 | 2.49 | 3.11 |

**Smoothness at La Source** (lap 4 vs lap 3). The measure is the rms of the third difference across the line, in mm. A smooth curve of any radius scores near 0.
- **First Lateral version:** 80 mm. The squiggles were visible in the app.
- **Lateral now:** 22 mm, after smoothing `path_lateral` and the centreline ±4 m and taking normals over ±10 m.
- **GPS ±4, for comparison:** 28 mm.

A test pins this: the lateral line must be smoother than GPS ±4 there.

**Out-lap and in-lap:** `path_lateral` stays under 8 m on both (laps 0 and 6), so the 15 m off-track fallback never triggers there. Only the invalid lap 5 exceeds it (29.5 m).

## Against the target

- **The two methods agree within ~1 m: met by a wide margin.** p95 is under 0.15 m everywhere, including Eau Rouge and Bus Stop. GPS and `path_lateral` are separate channels in the recording, so agreement at the centimetre level is strong evidence that both are accurate.
- **Repeated laps repeat within ~1 m on straights: not met (1.58 m mean). This is the driving, not the measurement.**
  - Every method, at every smoothing level, gives the same spread. Measurement noise would differ between methods.
  - The four laps really did take lines about 1.5 m apart on the straights, where a driver has room.
  - The target assumed repeated laps follow the same line on straights, and that assumption doesn't hold. Agreement between the methods is the better proxy for accuracy.

## In the app

User check, 2026-11-05:
- **Lateral and GPS look right** at Eau Rouge, Bus Stop and Kemmel. There are "minor squiggles on some straights and corners, but tolerable" (after the smoothing fix).
- **The first version had visible squiggles at La Source.** They were traced to the 10 Hz `path_lateral` being interpolated linearly, and fixed as described above.
- **Car sync:** time and distance modes both work.
- **Not yet checked:** comparing against an out-lap. The centreline is built from the two compared laps, so the pit-lane section of an out-lap is averaged into it. The Lateral line may bend at pit exit and pit entry there.

## Recommendation

- **Keep the Lateral method as the default line**, with the GPS ±4 m line as its fallback off track.
  - It agrees with GPS to a few centimetres.
  - It's smoother through corners than GPS ±4.
  - It comes with a centreline, which #36 (edges and kerbs) needs anyway.
- **Keep GPS ±4 as a selectable alternative** for debugging. Drop the 0/2/8 options.
- **Keep both car-sync modes, defaulting to time-synced.**
- **For the build issue:**
  - When the comparison lap is an out-lap or in-lap, build the centreline from the flying lap only.
  - The backend should compute the centreline once per track from all valid laps rather than per comparison. That's #41's territory: serve track geometry from the API.
  - If the remaining squiggles matter, try cubic interpolation of `path_lateral` at extraction time instead of linear.

## Screenshots

_To add: Eau Rouge, Bus Stop and Kemmel at 20–50 m in Lateral mode, and La Source before and after the smoothing fix (`img/lines-*.png`)._

## Decision

**Keep** (2026-11-05), as recommended above: Lateral by default, GPS ±4 m as fallback and alternative, both car-sync modes. The remaining minor squiggles are acceptable for now.
