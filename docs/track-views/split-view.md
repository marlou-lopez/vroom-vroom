# Split view: the lap and the reference lap side by side (vroom-ueg.7, #104)

Experimental, in the 3D view (`Split` button next to the Cars sync toggle; the choice is remembered in the browser).

## What it does

- Two panes in one canvas, the lap on the left and the reference on the right. Each follows its own car with the same camera mode (chase, cockpit, orbit, top). Both play from the one timeline, so scrubbing moves both.
- **Sync** is the existing Time / Distance toggle: by distance both cars are at the same metre of track, by time both are at the same moment (so the gap shows as where each car is).
- Each pane is labelled with its lap time and, live, the speed and gear of its own car. Between the panes a pill shows the delta from `CompareResponse.delta` at the lap car's metre (+ = the lap is behind).
- Cockpit: each pane has its own driver's eye, dash, wheel and rear-view mirror, driven by that car's own channels and attitude estimate (the reference's dash delta has the opposite sign).
- Orbit: the drag and wheel steer the lap pane's camera; the reference pane keeps the same viewing offset from its own car, so both panes turn together. The wheel zoom of chase and top applies to both panes.
- Annotation badges mark the reference line, so in the split view they are drawn in the reference pane.

## How it is drawn

One `WebGLRenderer`, one scene, one canvas: each frame does one pass per pane with `setViewport` and `setScissor` on the pane's half (`ribbon/split.ts` `paneRects`), then the cockpit mirror's pass of each pane. A second camera, rig set, cockpit dash and mirror are made the first time the split view is used. Each pane shows only its own cockpit (the other's is hidden for the pass), and its own car's box or model is hidden in the cockpit view.

## Options considered

- **Side by side (built).** Equal panes make the comparison direct: the same corner, the same camera, the same metre, with no pane favoured. It also works in cockpit, where an inset would be too small to read the line.
- **Picture-in-picture (reference as a small inset).** Keeps the full-size main view, but the inset is too small to judge a line, and the cockpit's dash and mirror would not fit. Not built.
- **Top-down pane plus a cockpit pane for one car.** Good for "where on track am I", but it compares nothing between the laps. It can already be had by using the top camera on one view; not built.

## Measured

Benchmark (`?debug`, "Run benchmark"; new phases `split` and `split-cockpit`), Chrome (headless, Windows GPU), 1904x985 window, track panel 1890x806 px (expanded), dpr 1:

| phase | fps | p95 ms | max ms | draw p95 ms |
|---|---|---|---|---|
| follow (chase) | 82.0 | 16.0 | 16.7 | 0.5 |
| scrub | 82.7 | 16.3 | 16.8 | 0.4 |
| orbit | 83.1 | 16.2 | 16.5 | 0.4 |
| cockpit | 82.7 | 16.1 | 55.4 | 1.2 |
| **split (chase)** | 82.0 | 16.2 | 17.0 | 0.5 |
| **split (cockpit)** | 82.7 | 15.7 | 19.5 | 1.6 |

The display refreshes at about 82 Hz, so every phase sits on the display's frame rate; the "draw" column is CPU time to submit the frames (the GPU's own time is not measured). The split view costs about one extra scene pass, so more GPU headroom is used than the table shows.

## Limits

- The pane labels use the recorded lap times from the lap list (passed to the view as the optional `lapTimes` prop; not a contract change). Without them they fall back to the last time on the 1 m grid.
- In a 945 px wide cockpit pane the right-hand display (delta) is cut off at the pane's edge. I did not check whether a single view that narrow does the same.
- Toggling Time / Distance while playing teleports the reference car; its camera restarts at the car instead of swinging.
