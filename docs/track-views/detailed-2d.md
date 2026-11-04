# Detailed 2D map (#35)

**Question:** a 2D map you can zoom into and that follows the cars, showing clearly where the lap and the reference lap are.

**Status:** spike. The prototype is in the app under *2D detailed* (experimental), built on WebGL as decided in #33. It uses the racing lines from #34. **Decision (2026-11-05): keep, built within #45.**

## What was built

The code is in `frontend/src/components/mapviews/detailed/`, with the camera in `frontend/src/lib/camera.ts`.

- **Follow mode** (default): the camera is centred on your car, 150 m across.
  - **Heading-up** is optional and rotates the map so your car always points up.
  - The rotation is blended along the shortest arc (`smoothHeading`, α = 0.2 per frame). It's reset after a jump of more than 50 m, so seeking doesn't swing the view.
  - The mouse wheel changes the follow width without leaving Follow.
- **Free mode:** the wheel zooms at the cursor, dragging pans, and **Fit** shows the whole track. Dragging more than 3 px in Follow switches to Free, starting from the current picture. Choosing Follow again restores the last follow width.
- **Zoom range:** 20 m across up to the whole track × 1.2.
- **Lap vs reference styling** (WebGL):
  - **Lines:** the lap line (2.5 px) is drawn above the reference line (2 px), which has a 4 px dark casing. Both lines are dimmed 45% toward the background, so the full-colour cars stand out from their own lines.
  - **Cars at 300 m across or wider:** your car is a filled dot and the reference car a hollow ring, as on the classic map.
  - **Cars below 300 m:** both become arrows pointing the way they're travelling. Your arrow is filled with a light outline; the reference arrow is hollow with a grey outline.
  - **Sizes** stay constant on screen at every zoom.
- **Click to seek:** a click (under 4 px of movement) within 12 px of your line seeks there. Press-and-drag pans instead.
- **Same-frame drawing:** while playing, the map draws in the same animation frame that advances the playhead. The spike's first version trailed by one frame.
- **Badges and hover cards:** an HTML layer positioned from the camera each frame, using the same `AnnotationHoverCard` as the classic map. Badges outside the view are hidden.

## Results

**Performance:** see `renderer.md`. WebGL held the display's refresh rate (180 Hz) in follow, scrub and zoom-pan, at 1898×815 with the CPU throttled 4× and at 2538×1175 without throttling. That is well above the 60 fps target. These runs predate heading-up and the extra styling. Those add a handful of meshes and one line, and don't change the per-frame work in any meaningful way, but they have not been benchmarked separately.

**User check, 2026-11-05:**
- **Working:**
  - heading-up rotation is smooth;
  - seeking doesn't swing the view;
  - the arrows point the right way;
  - clicking the line seeks smoothly;
  - press-and-hold pans.
- **Fixed:** your car was hard to tell from your own line because they were the same colour. The lines are now dimmed and your arrow outlined. Re-checked: okay for now.
- **Hover cards** on this map work (checked after running Analyze).

## Against the target

| Target | Status |
|---|---|
| Follow mode, centred on your car, ~150 m across, optional heading-up | met |
| Free mode: wheel zoom, drag pan, scrubbing still moves the cars | met |
| Zoom from the whole track down to ~20 m across | met |
| Lap vs reference distinct and readable at every zoom | met after the colour fix ("okay for now") |
| Badges and hover cards keep working | met |
| Steady 60 fps while following and scrubbing at 1080p | met (180 fps with the CPU throttled 4×) |
| Line placement from the racing-lines spike | met (Lateral by default) |

## Known limits

- **Click-to-seek searches the whole lap.** Zoomed out, where the track passes close to itself, a click can land on the other section. The classic map keeps a drag within ±150 m of the car; a click here has no such window.
- **The track edges are a stand-in** (centreline ±7 m) until #36.
- **The arrow outlines are slightly larger triangles drawn underneath**, not true strokes. Fine at these sizes.
- **Nothing has been checked on a high-DPI laptop or an integrated GPU.** That check is part of #45.

## Recommendation

**Keep.** Build it as part of #45 (the WebGL renderer), plus:
- the defaults above: Follow, 150 m, north-up, with heading-up as a toggle;
- click-to-seek limited to a window around your car when zoomed out, or to the nearest point on screen;
- the styling above as the starting point;
- the benchmark and frame-rate display kept behind a dev flag rather than shipped.

## Screenshots

_To add: follow north-up and heading-up at 150 m, 20 m with arrows, and the whole track (`img/detailed-*.png`)._

## Decision

**Keep** (2026-11-05). Build it within #45, with the recommendations above.

## Built (#45)

- WebGL only: the SVG and Canvas renderers, the renderer toggle and the `vroom.detailedRenderer` key are gone. three.js loads as its own lazy chunk.
- Debug flag (`?debug`, or `npm run dev`): the frame-rate HUD, the benchmark, the Lateral / GPS line selector and a "Lose GPU context" test button show only there. Without it the line is always Lateral. The view is no longer marked experimental.
- Context loss: on `webglcontextlost` drawing stops and a "Graphics reset" notice shows; on restore a fresh renderer is built. After 3 s without a restore the notice offers Retry.
- Click-to-seek: among line points within the hit radius, the one nearest the car along the lap wins (circular lap distance, then nearest on screen), so a click where the track crosses itself picks your section.
- Out-lap centreline: when the comparison lap is an out-lap or in-lap, the centreline comes from a flying lap only.
