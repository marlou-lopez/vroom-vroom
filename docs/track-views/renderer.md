# Renderer for the detailed track views (#33)

**Question:** what should draw the detailed 2D view (and later the 3D view)? Options: keep SVG, move 2D to Canvas 2D, or use WebGL. Could one WebGL renderer serve both 2D and 3D with a shared camera?

**Status:** spike, prototype in the app under *2D detailed* (experimental). **Decision (2026-11-05): keep, using WebGL (three.js) for both the detailed 2D and the 3D views.**

## What was built

- **One camera module** (`frontend/src/lib/camera.ts`): centre, width in metres, and rotation. It converts between world and screen, zooms at the cursor, pans, fits the track and follows the car. It's pure and unit-tested, and all three renderers use it.
- **One scene** (`mapviews/detailed/scene.ts`): the lap line, the reference line, two edges and two cars, in local metres. Each line is about 7,000 points, the full lap. The edges are a stand-in (centreline ±7 m) until #36.
- **Three renderers behind one imperative interface:** `setScene`, `resize`, `draw(frame)`, `destroy`.
  - **SVG:** paths are built once in world coordinates. Each frame only changes the group's `transform`, and `non-scaling-stroke` keeps line widths constant.
  - **Canvas 2D:** cached `Path2D`s, with `setTransform` each frame and a line width scaled to stay constant on screen.
  - **WebGL:** three.js 0.186.1, an orthographic camera, and fat lines (`Line2`), loaded on demand as a separate chunk.
- **The draw loop** runs from `store.subscribe` plus one coalesced `requestAnimationFrame`. React never re-renders per frame.
- **Badges and hover cards** are an HTML layer above the canvas, repositioned each draw with `worldToScreen`. They're the same Radix `AnnotationHoverCard` as on the classic map. This works identically in all three renderers, so badges don't decide the renderer.
- **Benchmark** (button in the view): it runs three 10 s phases. The frame interval comes from rAF timestamps; draw time is measured around `draw()`.
  - follow: playing at 1×, with the camera following the car at 150 m across;
  - scrub: seeking 40 m per frame across the whole lap;
  - zoom-pan: zooming between 20 m and the whole track while panning.

## Results

Edge 156 on Windows, devicePixelRatio 1.

**Run 1: 2552×1354 window, map panel expanded to 2538×1175, no throttling** (180 Hz display)

| renderer | phase | fps | p95 ms | max ms | >20 ms |
|---|---|---|---|---|---|
| canvas | follow / scrub / zoom-pan | 179.8 / 179.6 / 179.9 | 5.7 / 5.6 / 5.7 | 9.0 / 9.0 / 5.7 | 0 |
| webgl | follow / scrub / zoom-pan | 179.9 / 179.9 / 179.6 | 5.6 / 5.6 / 5.6 | 8.9 / 5.7 / 9.0 | 0 |

**Run 2: 1920×1080 monitor, window 1912×994, map panel 1898×815, CPU throttled 4× in DevTools**

| renderer | phase | fps | p95 ms | max ms | >20 ms |
|---|---|---|---|---|---|
| svg | follow | 165.4 | 11.1 | 12.0 | 0 |
| svg | scrub | 176.4 | 5.7 | 11.2 | 0 |
| svg | zoom-pan | 155.3 | 11.2 | 11.3 | 0 |
| canvas | follow / scrub / zoom-pan | 179.9 / 179.6 / 179.9 | 5.7 / 5.6 / 5.7 | 5.8 / 9.0 / 5.7 | 0 |
| webgl | follow / scrub / zoom-pan | 179.9 / 179.6 / 179.6 | 5.7 / 5.7 / 5.7 | 5.8 / 9.1 / 9.0 | 0 |

**Against the target (steady 60 fps at 1080p while following and scrubbing):** all three renderers pass, even with the CPU throttled 4×.

- **SVG** is the only one that drops frames under throttling: p95 jumps to one missed 180 Hz frame (11 ms) while following and zooming. That still leaves plenty of room at 60 Hz, but it's the first to degrade.
- **Canvas and WebGL** hold the display's refresh rate everywhere, so these runs can't separate them.

**Caveats**
- "draw p95" (0.1–0.2 ms everywhere) only measures how long it takes to queue the drawing commands. The browser paints later on the GPU, so the fps and p95 frame-time columns are the meaningful numbers.
- Both runs used one fast desktop. A weaker machine (laptop iGPU, high-DPI screen) has not been tested.

## Bundle cost

| | gzip |
|---|---|
| main chunk before this work | 148.9 kB |
| main chunk now (view, bench, SVG and Canvas renderers) | 155.3 kB |
| three.js chunk (only fetched when WebGL is picked) | 138.6 kB |
| react-three-fiber (not used) | adds its own runtime on top of three.js (not measured here); its current major (9.x) needs React 19, so this React 18 app would need 8.x |

## Findings

1. **Performance doesn't decide between Canvas and WebGL for 2D.** Both have headroom at 1080p even with a 4× slower CPU. SVG works, but it's the first to degrade, and it would degrade further with more geometry (real edges, kerbs, several laps).
2. **Badges and hover cards** work the same way in every renderer, as an HTML overlay positioned from the shared camera.
3. **One camera model serves all three renderers.** The WebGL camera matches the 2D maths exactly (checked numerically), so a 2D view and a 3D top-down view can share `Camera` and the input handling.
4. **The cost of WebGL is 139 kB gzip of three.js**, loaded only when the WebGL view is opened, and more complex code (disposal, context loss, fat-line resolution).

## Recommendation

**Canvas 2D for the detailed 2D view, and three.js for 3D only (#39), both sharing `lib/camera.ts`.**

- **Why Canvas:** it matches WebGL on speed with no new library, its code is the simplest of the three, and it's crisp at any devicePixelRatio. It also handles the next layers (edges, kerbs, several laps) without the DOM cost that SVG has.
- **Why three.js only for 3D:** the 3D view needs it anyway. Using it for 2D as well would mean loading 139 kB for a view that doesn't need it.
- **react-three-fiber:** decide that in #39. The project is on React 18, so only the older r3f 8.x line would work.
- **The alternative:** WebGL for both, if you'd rather have one renderer and a seamless 2D ↔ 3D camera transition. The cost is the chunk and more complex code; performance is the same.

## Screenshots

_To add: each renderer at ~100 m around Bruxelles (`img/renderer-svg.png`, `img/renderer-canvas.png`, `img/renderer-webgl.png`)._

## Decision

**Keep, using WebGL for both 2D and 3D** (2026-11-05). This is the alternative above, not the Canvas recommendation. The user chose one renderer and one camera across the detailed 2D view and the 3D view (#39), accepting the 139 kB lazy chunk and the extra lifecycle code. Follow-up work:
- Build issue #45 drops the SVG and Canvas prototypes and keeps `lib/camera.ts` as the shared camera.
- #35 builds its follow/free polish in the WebGL renderer only.
- #39 decides whether react-three-fiber (8.x on React 18) wraps the same renderer.
