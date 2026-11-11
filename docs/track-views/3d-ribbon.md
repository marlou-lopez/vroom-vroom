# 3D track ribbon with elevation and a follow camera (#39)

**Question:** can the 2D map be raised into 3D with the Spa elevation profile (#94), with both cars and useful cameras, and read correctly through Eau Rouge / Raidillon, at a steady 60 fps?

**Status:** spike, prototype in the app under *3D* (experimental). **Decision: keep (2026-11-06).**

## What was built

Code in `frontend/src/components/mapviews/ribbon/`, behind the same `TrackViewProps` as the other views. The 3D renderer (three.js, `OrbitControls`, fat lines) is a lazy chunk, loaded like the detailed 2D one.

- **Reused, not copied:** `detailed/scene.ts` (`buildScene` with telemetry edges and kerbs; `carPositions` for time or distance sync), `lib/camera.ts` (`smoothHeading`), `lib/debugFlag.ts`, `detailed/bench.ts` (`runPhase`, report format), the playback-store subscription plus coalesced rAF loop. From `DetailedMapView.tsx` I extracted to `mapviews/shared/`: the badge/hover-card layer (`AnnotationBadges`), the frame-time `Ring`, and the localStorage helpers; the detailed view now imports them. `Kerb` in `scene.ts` gained a `start` index (the centreline index of its first point) so kerbs can take road heights.
- **Coordinates** (`coords.ts`, one place, tested): three x = east, y = up, z = -north.
- **Road heights** (`heights.ts`): per centreline index, the track geometry's `elevation_m` (cut or padded to the centreline), gaps linearly interpolated (ends hold), then a +/-2 m moving average. The height is the car's reference point height and is used as the road height (a constant offset would be fine for a spike; none is applied). Without elevation the view is flat and shows "No elevation for this track".
- **Ribbon** (`geometry.ts`): a triangle strip between the left and right telemetry edges, one height per index applied to both edges (no banking), closed into a loop when the lap's ends are within 30 m. Kerbs are red/white quads per metre. Edge lines sit 2 cm, kerbs 3 cm, the dim line ahead 5 cm and the driven part of each racing line 7 cm above the surface (before the exaggeration; the surface has a polygon offset).
- **Racing lines:** lap and reference as fat lines in the 2D colours. The driven part is brighter, the part ahead dimmer and half as thick, like #48 (the reference line is solid, not dashed).
- **Cars** (`pose.ts`): two boxes (body plus a cabin, 1.2 m tall in total) at the true size from `lap_car_dims` / `ref_car_dims`, falling back to the generic GT3 size. Heading from the line; pitch from the road-height slope along the car's own line over +/-3 m, multiplied by the exaggeration so a car sits flat on the stretched surface.
- **Exaggeration:** Radix slider 1x-5x in steps of 0.5, remembered per viewer in localStorage. **Default 1x**: the true shape, so the chase view and the car pitch show the real road (Raidillon peaks at about 16 % grade). 100 m of range over 7 km looks flat from orbit or top, which is what the slider is for. It is applied by scaling the y of the group holding the ribbon, kerbs and lines, so changing it rebuilds nothing.
- **Cameras** (`cameraRigs.ts`): a `CameraRig` per mode with `enter(frame)`, `update(frame)`, `zoom`. *Chase*: 12 m behind and 4.5 m above the lap car, smoothed heading and height, looking at the line point 30 m ahead (wheel zooms). *Orbit*: three's `OrbitControls`, the target follows the car and the camera moves with it, so your chosen offset is kept. *Top*: straight down above the car, north up (wheel changes the height). A cockpit camera is a fourth rig: `CameraFrame` already has an optional `eye` (position and orientation) to carry the shared-memory pose.
- **Annotations:** the same badges and hover cards as the detailed 2D view, positioned each draw from a projection of the apex point (3 m above the road); hidden behind the camera or off screen.
- **Lighting:** hemisphere plus one directional light, so slope reads; fog fades the far track (its start follows the camera distance).
- **Failure handling:** context loss shows "Graphics reset - restoring..." and rebuilds the renderer on restore (Retry after 3 s), like the 2D view. A failed chunk load shows "The 3D view could not load." with Retry instead of a blank view (the 2D view only logs; #71).
- **Debug** (dev or `?debug`): fps HUD (also draw calls and triangles), benchmark with three 10 s phases (follow in the chase camera, scrub the lap, orbit around the car while it drives), "Lose GPU context".

## Results

Measured here (Spa, laps 4 vs 3, node, no GPU):

- **Mesh sizes:** 6,980 centreline points. Track surface 13,960 vertices and 13,960 triangles (closed loop). Kerbs: 20 stretches, 2,448 vertices, 1,224 triangles. Cars: 4 boxes, 48 triangles. About 15.2k triangles in all, plus 6 fat lines (two edges, two racing lines each drawn twice: driven and ahead) of 6,980 segments each.
- **Heights:** the ribbon vertices at index 1005 are -1.0 m and at 1305 are 25.4 m (within 0.5 m, tested); range of the lap about 100 m.
- **Pitch** (tested): the lap car is nose-up on the Eau Rouge / Raidillon climb (about 0.16 rad, 16 %, around 1060 m in), nose-down on the descent from the first straight (about -0.065 rad), and the exaggeration steepens it.
- **Building:** `buildScene` 24 ms, ribbon and kerb meshes 3.6 ms, once per lap pair. Per-frame CPU work outside the GPU (car positions, poses, look-ahead) is about 0.7 microseconds.
- **Bundle:** the 3D renderer is `threeRibbon-*.js`, 28.1 kB (7.8 kB gzip). three.js with the fat lines and `OrbitControls` is the shared `Line2-*.js` chunk, 582 kB (147 kB gzip); the main chunk is 481.5 kB (163 kB gzip) and has no three.js in it.
- **Tests:** 339 passed in the whole suite (the new ones are in `ribbon/`: 39 tests in 6 files).

### Frame rate against the target (steady 60 fps while following and scrubbing, 1080p, Windows)

To be measured by the user on Windows with the benchmark (`?debug`, "Run benchmark"). I could not run the GPU path here.

| phase | fps | p95 ms | draw p95 ms |
|---|---|---|---|
| follow | to be measured | | |
| scrub | to be measured | | |
| orbit | to be measured | | |

### Screenshots

To add.

## Known limits

- **No banking:** each index has one height and both edges use it, so a banked or cambered corner reads flat across. Capturing the orientation matrix (`mOri`) in the logger would give the roll.
- **Road height is the car's reference height,** not the measured road surface; a constant offset to the real road is not applied. Where the lap or reference leaves the captured path the height is interpolated.
- **Only the ribbon:** no terrain, walls or scenery beyond the edges; where a racing line leaves the edges (run-off, pit lane) it floats at the centreline height.
- **Eau Rouge bottom:** the valley floor is about -5.0 m at about 926 m in, and the top of Raidillon 30.3 m at about 1399 m. The tests check -1.0 m at 1005 m and 25.4 m at 1305 m, points partway up the climb (the docs now say so).
- **Boxes, not a car model;** the reference line is solid, not dashed; no click-to-seek on the 3D map; the exaggeration also scales the small lifts above the surface.
- Elevation only exists for Spa (the mock); other tracks draw flat.

## Next

- **Cockpit camera:** a new `CameraRig` that places the camera at the driver's eye, using position and orientation (`mPos` / `mOri`) from shared memory once the backend serves them.
- **#102:** a real 3D car model instead of the boxes (spike).
- Banking from `mOri` roll; terrain and scenery from public data if the view is kept.
- Move the renderer-lifecycle code (load, context loss, retry) shared by the detailed and 3D views into one hook as part of #77.

## Decision

**Keep** (2026-11-06). The user checked the prototype in the browser and keeps the 3D ribbon as the 3D view. Follow-ups are in "Next steps" above.
