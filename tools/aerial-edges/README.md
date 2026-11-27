# aerial-edges

**Not a supported edge source** (dropped by vroom-ueg.11, frozen experiment).

Track edges and kerbs from open aerial imagery, in LMU's world frame (experimental, vroom-ueg.8). Method, numbers and
licences: `docs/track-views/aerial-imagery.md`.

```bash
cd tools/aerial-edges
uv run --no-project --with numpy,scipy,pyproj,pillow python -I run.py spa
```

This downloads the imagery and the OpenStreetMap raceway once into `cache/` (git-ignored: never commit imagery), fits,
extracts, prints a report as JSON and writes `cache/spa-aerial.json`. The first run takes a few minutes, later ones 30 s.
`--crops <folder>` also writes check pictures with the result drawn on: cyan = edge on a seen line, magenta = guessed (not
written out), blue = kerb's outer side. Look at them before trusting a new track. They hold imagery, so don't commit them.

To refresh the app's copy: `--out ../../frontend/public/mock/spa-aerial-2023.json`.

## Ground texture for the 3D view (experimental, vroom-ueg.9)

```bash
uv run --no-project --with numpy,scipy,pyproj,pillow python -I run.py ground spa
```

Writes JPEG tiles in LMU's world frame and `ground.json` (positions, credit line) to `frontend/public/local-ground/<track_id>/`, which is git-ignored and
not in builds. **Never commit it, or a picture of it.** It replaces that folder's earlier output. Show it in `npm run dev`: 3D view, View options,
Ground (experimental). `--reach 150` is how far it goes either side (the first run downloads about 120 tiles more than the edges need, some 10 minutes),
`--out` writes elsewhere, `--terrain 250` only compares Wallonia's LiDAR terrain model with LMU's heights every 250 m (Spa only; needs `elevation` in the
track file). A track needs `track_id` (the app's) in `tracks/<name>.json`.

### Terrain heights (vroom-ueg.13, Spa only)

`run.py ground spa --heights` (or `--heights-only` on an existing folder) also asks Wallonia's LiDAR terrain model (SPW MNT 2021-2022, CC BY 4.0) on a thin lattice:
every 30 m along the line, 0, 10, 30, 75 and 150 m beside it on both sides, about 2,000 single-point requests with 2 workers (some 30 to 60 min the first time,
answers are cached in `cache/terrain_wallonia.json`). It interpolates the lattice and LMU's own heights on the line to the 3D view's 4 m grid and writes
`terrain.bin` (float32, LMU's height frame) beside the tiles. `--verify` asks fresh points between the lattice's and prints the mesh's error 10, 30 and 75 m
beside the line. The 3D view reads the file as is (no height computing in the browser) and shows the terrain credit next to the photo's. Without `terrain.bin`
the ground follows the track heights as before.

## Add a track

The Le Mans blind check failed (write-up, vroom-ueg.11): a lap that OSM's `highway=raceway` does not cover (public roads) fails at the alignment. Check `coarse.osm_median_m` first.

1. Find an open source (the table in the write-up). Esri, Google and Bing imagery may not be used: their terms forbid extraction.
2. If it has no adapter: copy `sources/wallonia.py` (a map service that renders any box) or `sources/agea_2024.py` (fixed
   tiles). An adapter is one file with a `Source` subclass and `SOURCE = ...`: the projection (`crs`), `attribution`, `licence`,
   `tile_px`, and three methods: `tile_of(x, y)`, `tile_box(key)`, `download(key)`. Caching, pauses, retries and sampling are in
   `sources/base.py`. Read the service's terms and put what they ask in the docstring.
   For downloaded GeoTIFFs, make `download` return the matching crop of the file instead of calling a service.
3. Add `tracks/<name>.json`: `track`, `source` (the adapter's file name), `bbox` (south, west, north, east around the circuit),
   `recordings` (mock JSONs with flying laps of the track, from `tools/extract-laps.mjs`; more laps on both sides of the
   road fit better), `survey` (a `decode.py survey` file to grade against, or null).
4. Run it with `--crops`. Check `refined.residual_median_abs_m` (under 0.2 m on Spa and Monza) and look at every picture.
5. To show it in the app: write it to `frontend/public/mock/`, and serve it as `TrackGeometry.aerial` (see `src/api/mock/aerial.ts`).

The tool needs only recordings. The survey is used for grading, never for the fit.

A line that fails the confidence test (`confidence.py`) is written as unseen; `rejected_by_confidence` in the report counts those metres. Unit tests: `uv run --no-project --with numpy,scipy,pytest python -I -m pytest -q test_confidence.py` in this folder.
