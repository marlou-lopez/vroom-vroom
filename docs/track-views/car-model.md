# A real 3D model of the McLaren 720S GT3 in the 3D view (#102)

**Question:** can a real car model replace the true-size box in the 3D view (#39, #100): where could it come from, can this public repo ship it, what does it cost in size and frame rate?

**Status:** prototype ("bring your own model", marked experimental). **Decision: keep (2026-11-06).** The user checked it in the browser: the model loads, converts in the browser and looks right, and the benchmark held 180 fps (the display's refresh) at 2552×1354 with draw p95 0.9 ms (0.2 ms with boxes). The model itself is never committed; only the loader, the in-app picker, the converter and the folder convention are.

## Answer in short

- **The candidate model cannot be committed or redistributed.** Its listing says CC-BY-4.0, but its contents say it was taken from a racing game (see Provenance), so the grant is doubtful. The repo is public, so the model, its textures and every file derived from it stay out of git.
- **So the feature is "bring your own model"**: the user loads a `.glb` for a car in the 3D view's **Car** popover (kept in this browser only), or a developer drops `frontend/public/local-models/<car_id>.glb` into that git-ignored folder; with neither, the box stays. For the 720S the car_id is `mclaren_720s_gt3_evo`.
- **Cost, measured:** the 46 MB source (473,493 triangles, 54 textures) becomes a 2.3 MB GLB (115,071 triangles, 41 draw calls) with `tools/optimize-car-model.mjs`. The 3D chunk grows by about 75 kB (22 kB gzip) plus 33 kB (7.7 kB gzip) in the shared three.js chunk; the main bundle is unchanged.
- **Frame rate with two cars: not measured** (needs a browser; run the benchmark under `?debug`). Expect about 91 draw calls and 230k triangles, which is modest for a GPU but several times the box version.

## Provenance and licence of the candidate

The user downloaded a glTF of a "2020 McLaren 720S GT3" from a model marketplace. Its `license.txt` says CC-BY-4.0 (credit the author, commercial use allowed). Its contents do not look like something the uploader made:

- Node names follow the Assetto Corsa / ACC car-file conventions of Kunos' games: `CINTURE_ON` (seat belts), `COCKPIT_HR` / `COCKPIT_LR` (high and low detail cockpit), `STEER_HR` / `STEER_LR`, `RIM_BLUR_*`, `LUMIRANK`, `DISPLAY_DATA`, `DAMAGE_GLASS_*`, `RPM_LED_0` to `RPM_LED_9`, `EXT_` / `INT_` material prefixes and an `.fbx` root.
- That is a game-ready asset with a physics-linked rig (damage glass, rev LEDs, wheel blur), which a hobbyist modelling from scratch does not normally build.

So it is very likely extracted from a game and re-uploaded. Whoever uploaded it probably did not hold the rights to license it, and a CC-BY label on the page does not change that. Trademark applies too: the McLaren name and the car's shape, and a race livery if the model has one.

**What a safe source would need:** a model whose author made it themselves, under a licence that allows redistribution with a credit we can carry in the repo (CC-BY or CC0), with a provenance we can believe (a modeller's own work, not a game rip), or a model built by hand. Even then keep brand and livery concerns in mind for a public repo. LMU's own car files are off the table (encrypted, EULA). This spike did not find or evaluate such a source; the marketplaces named in the issue were not searched.

## Bring your own model

### Lookup order (per `car_id`)

1. **The user's model in this browser** (IndexedDB), loaded through the Car popover.
2. **`frontend/public/local-models/<car_id>.glb`**: a developer convenience, kept. Git-ignored except its `README.md`; `git status` must show no model data.
3. **The box.**

The box shows until a model is ready, and any failure (no file, the dev server's HTML fallback for a missing file, a corrupt or unreadable file) silently keeps the next fallback. A stored model that no longer parses falls through to the folder, then the box. `car_id` comes from the API (`CompareResponse.lap_car_id` / `ref_car_id`); the popover shows `lap_car_name` / `ref_car_name` (all four new in this spike, copied from the laps' session).

### The Car popover (`ribbon/CarModelControl.tsx`)

A **Car** button beside the camera, sync and elevation controls of the 3D view (always there, not a debug control) opens a Radix popover. For the lap car, and the reference car when its `car_id` differs, it shows the car name and the current source: "Box", "Your model: name.glb (2.3 MB)" or "Local file" (a probe of the folder URL that checks the first bytes for the glTF header, because the dev server answers a missing file with HTML).

- **Load file... / Load folder...** (and drag-and-drop of a file, folder or zip onto the car): a `.glb`, a `.zip` holding a glTF, or a folder with a `.gltf` and its files (a raw Sketchfab download: `scene.gltf`, `scene.bin`, `textures/*`). See "Converting in the browser" below. The result is a `.glb` whose bytes must start with the glTF header and then parse with the same loader the view uses (`GLTFLoader` + `MeshoptDecoder`, loaded on demand). On failure it says "Couldn't read this file as a glTF binary (.glb)." under the car, stores nothing and keeps the current model. If the browser will not store it (blocked or full storage) it says so and stores nothing.
- **Rotate 180°:** for a model whose nose points the other way (the fit assumes the nose is at +z). A per-car flag stored with the model; it is kept when a new file replaces the old one.
- **Remove:** deletes the stored model, back to the next fallback.
- **Size:** above about 30 MB it warns ("may draw slowly", points to `tools/optimize-car-model.mjs`) but stores the file anyway.
- **Help text:** says which inputs work, that anything but a small compressed `.glb` is converted in the browser (and that the command-line script does the same); "Stays in this browser; it isn't uploaded"; and the reminder to use only a model you have the right to use.

Applying or removing a model updates the scene live: the store notifies its subscribers, the renderer puts the box back on the cars with that `car_id`, invalidates the loader cache for that `car_id` (and frees the old model's GPU resources), and loads again. No reload. Both cars of the same `car_id` share one model; the ref car uses it as the translucent ghost (below).

### Storage (`ribbon/carModelStore.ts`)

IndexedDB database `vroom-car-models`, object store `models`, one record per `car_id`: `bytes` (the GLB as picked), `fileName`, `size`, `addedAt`, `rotate180`. Nothing leaves the browser (there is no backend yet). Every call is in try/catch: with IndexedDB missing or blocked (private window), reads give "no model" and writes give false, and the view just keeps the box or the folder model. Browsers may evict site data under storage pressure; the model is then simply gone and has to be loaded again. Records are not synced between browsers or machines.

### Other facts

- **Loading** (`ribbon/carModel.ts`, in the lazy 3D chunk): once per car_id and cached until the car's stored model changes.
- **Production build:** Vite copies `public/` into `dist/`, so a build made on a machine with a folder model contains it. `dist/` is git-ignored; do not publish such a build. Models loaded through the popover are never in a build.
- **Which cars:** any car, if a model is supplied for its `car_id`. A car with no `CarDims` uses the generic GT3 fallback size (as the box does) for the fit. A generic GT3 stand-in for cars without a model was not built.

### Converting in the browser (`ribbon/convert/`)

No Node or terminal is needed. Inputs: one `.glb`; a `.zip` with a glTF in it; a folder (`<input webkitdirectory>` or a dropped folder; paths come from `webkitRelativePath` / `webkitGetAsEntry`); or a `.gltf` plus its files picked together. `fileSet.ts` classifies the pick (`scene.gltf`/`scene.glb` win in a folder) and resolves the glTF's relative buffer and image URIs against the file set (URL-decoded, `..` resolved, case-insensitive fallback; `data:` URIs left alone). A referenced file that isn't there is an inline error naming it ("The model refers to "scene.bin", which wasn't in the files you chose..."). Other errors shown inline: an unsupported extension (checked before any work starts), a zip with no glTF, invalid glTF, Draco-compressed input (not re-optimised: load the `.glb` as it is), and out of memory.

- **Skipping:** a single `.glb` of at most 15 MB that already uses `EXT_meshopt_compression` or `KHR_draco_mesh_compression` is stored as it is. Anything else is converted while the **Optimise** checkbox (default on) is checked. With it off the files are only packed into one `.glb`, unchanged (textures stay as large as they were).
- **Worker:** `convert/worker.ts`, a module worker (`new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`, `worker.format: "es"` in `vite.config.ts`). It imports `convert.ts` (gltf-transform core, extensions and functions, `meshoptimizer` with its inline WASM, `fflate`) and `webpEncoder.ts` only when a request arrives, so none of it is in the main bundle or the 3D view's chunks. The files go to the worker as transferred `ArrayBuffer`s and the finished `.glb` comes back transferred, so nothing is copied.
- **Progress and Cancel:** the popover shows "Step n of 6: Reading / Cleaning / Simplifying / Compressing textures / Compressing / Saving" with a **Cancel** button that terminates the worker. Closing the popover is blocked while a conversion runs, and unmounting cancels it. When it finishes, the popover shows before and after size and triangle count, validates the result with the real loader, stores it like a loaded `.glb` and applies it live.
- **Zip reader: `fflate` 0.8.3.** Small (the unzip part is a few kB), no dependencies, synchronous `unzipSync`, runs in a worker, widely used and maintained. `@zip.js/zip.js` is bigger and streams, which a car model (tens of MB) doesn't need; a hand-written reader would need inflate anyway.
- **One shared definition:** `convert/settings.ts` (the drop list, the kept names, every setting, the stage names; no imports) and `convert/pipeline.ts` (the steps) are used by the worker and by `tools/optimize-car-model.mjs`, which imports the TypeScript files directly (Node 22.18+ strips the types; the project already uses only erasable syntax). The script is now a thin file reader plus a `sharp` WebP encoder around `convertFiles`.

**Pipeline** (`optimizeDocument`): drop the parts (lifting the kept steering wheel and LEDs out from under dropped parts first, naming the mesh nodes after them, anonymising the rest); `dedup`; `instance` (min 5); unless `keepGraph` (`--keep-graph`) `flatten` and `join`; `weld`; `simplify` (meshoptimizer, ratio 0.3, error 0.001, borders locked); `prune` and `sparse`; textures to WebP of at most 1024 px; `meshopt` (level high).

**Differences from the old `gltf-transform optimize` CLI run:**
- Same functions, defaults and order, except no `palette` (the old script switched it off), no `resample` (a car has no animations), and the texture step is our own (the CLI's `textureCompress` needs `sharp`, which doesn't run in a browser). The old script also called the CLI with `--join-named false`, which I read as joining named meshes too; here the names are removed first, so there is nothing named left to keep.
- Textures: the browser uses `createImageBitmap` (colour conversion and premultiplication off), an `OffscreenCanvas` with high-quality smoothing and `convertToBlob({ type: "image/webp", quality: 0.8 })`; `sharp` (script) uses quality 80 with its own resampler. The two encoders give slightly different bytes. A WebP already within the size limit is kept; if the browser returns a PNG instead of a WebP (no WebP encoding), the texture is left as it was. Alpha and normal maps are treated alike (no per-slot handling).
- A `.glb` that already uses Draco can't be re-optimised (no Draco decoder in the pipeline).
- The old script installed `@gltf-transform/core` and `npx`-ed the CLI at run time; the new one uses the versions pinned in `frontend/package.json` (4.5.1, `meshoptimizer` 1.3.0), so run `npm ci` in `frontend/` first. It still installs `sharp` into a temp dir (needs network once).

## Conversion on the command line

```bash
node tools/optimize-car-model.mjs <folder with scene.gltf> frontend/public/local-models/mclaren_720s_gt3_evo.glb
```

It runs the same pipeline as the browser (see above); the steps are:

1. **Prune** parts an exterior or chase view never shows: damage glass, rim blur, seat belts, the display, the Lumirank unit, wipers, brake discs, suspension arms, door insides and interior windows, the high-res cockpit (141k triangles) and the high-res steering wheel. The low-res cockpit (11k) and steering wheel stay: the cockpit camera hides the lap car, and a chase camera sees the cabin only through the glass.
2. **Anonymise and join:** node names are removed so the CLI can merge meshes that share a material (fewer draw calls). The low-res steering wheel keeps the name `STEER_LR`.
3. **Simplify** to 30% of the vertices (`--ratio`, border locked so thin parts survive), **meshopt**-compress, and textures to **WebP at 1024 px at most** (`--tex`).

`--keep-graph` skips the join, so `STEER_LR`, `RPM_LED_0` to `RPM_LED_9` and `Slip_*` stay as separate named nodes (98 draw calls, 2.5 MB; measured with the first version of this converter, before the fix below, and not measured again). In the default output the 14 LEDs are merged away by flatten and join. The LEDs were found under `DISPLAY_DATA`, which the script lifts out before dropping it.

**A converter bug, fixed in #101:** `dropParts` renamed the kept nodes while it was still walking them, so a node whose name came from its kept ancestor (e.g. a mesh node below `RPM_LED_5_105`) found the ancestor already renamed to `RPM_LED_5`, which no longer matches (`baseName` reads the `_5` as Sketchfab's suffix) and lost its name. The names are now all worked out before any is changed (`convert.test.ts` has a test that fails without the fix). It does not change the default output for a model whose mesh names match on their own. I could not confirm an earlier suspicion that the two-triangle LED quads then vanish in simplification: a quad kept its primitive through `optimizeDocument` with `keepGraph` in a test document; the real 720S file was not re-converted.

**Not supported: loading the car's interior (#101).** An optional "Keep cockpit interior" conversion (the high-res cockpit, wheel, LEDs and display kept by name and drawn in the cockpit view instead of our own cockpit) was built and then removed on the user's decision: one polished default cockpit is better than a second, model-dependent one that needs a particular model's node names, a per-model seat shift fitted to one car's windscreen, and 70k to 160k more triangles. The cockpit view therefore always shows our own cockpit (`cockpit-view.md`), whether or not a model is loaded; with a model loaded the lap car stays hidden in the cockpit view as before. The converter and the popover are as #102 shipped them, apart from the fix above.

### Sizes (measured with glTF Transform and three's `GLTFLoader`)

| | Source | After (default) | After (`--keep-graph`) |
|---|---|---|---|
| File | 46 MB (34 MB `.bin`, 54 PNG) | 2.31 MB | 2.54 MB |
| Triangles | 473,493 | 115,071 | 130,899 |
| Meshes / draw calls per car | 169 | 41 | 98 |
| Materials / textures | 76 / 54 (some 4096 px) | 39 / 29 (WebP, at most 1024 px) | same |
| Extensions | `KHR_materials_specular` | + meshopt, WebP, mesh quantization | same |

Simplification is aggressive (no visual check was possible): the body panels and the wheels are the places to look first. `--ratio 0.5` raises the size and triangle count; the pruning alone (before simplify) leaves 282k triangles.

## Fit

The model comes in a glTF scene exported from an FBX: `y` up, nose along `+z`, left side `+x` (like the box), but in units 100 times too small (an FBX centimetre scale left on a metre mesh). The fit therefore works from the measured bounds, not from assumed units (`fitModel` in `ribbon/carModel.ts`).

| | Native (glTF units) | After scale (m) | Sheet (`CarDims`) |
|---|---|---|---|
| Length (z) | 0.047570 | 4.664 | 4.664 |
| Width (x) | 0.021153 | 2.074 | 2.040 |
| Height (y) | 0.011961 | 1.173 | n/a |

- **Scale:** one uniform factor, 98.04, so the length equals `length_m`. The width then comes out 1.7% over the sheet width (2.074 m against 2.040 m; the wing mirrors probably set the model's width). Scaling width and length separately would squash the car; the sheet's width is from the box, not necessarily the widest point.
- **Axes:** the long axis is `z` with the nose at `+z` (the rear wing and exhaust are at `-z`: checked on the source). `fitModel` also handles a model long along `x` (turns it by -90 degrees about `y`, assuming the nose is at `+x`); that path is unit-tested only. A model with its nose the other way is not detected: the user turns it with **Rotate 180°** (a further half turn about `y`, with the centring redone; unit-tested).
- **Placement:** tyres on the drawn road (the lowest point of the model at `y = 0`, where the box's underside is 0.15 m above the road), centred sideways, and the length centred on the visual centre `visualForwardM(dims)` (0.0745 m for the 720S) ahead of the recorded point, as the box is. `visual_offset.up_m` is not used.
- **Pose:** the same as the box: `carEuler` (heading, pitch) on the car group, whose order is YXZ; the model is a child of it, so it follows without any change. Roll is not applied to the box either in this renderer (`g.rotation.set(e.x, e.y, 0)`).
- Wheelbase check: the model's front and rear wheel centres are 2.685 apart before the scale, 2.63 m after, against the sheet's 2.696 m (2.4% short): within what a hand-built model's tolerance would be.

## Look

- **Lap car:** the textured model, hidden in the cockpit camera as the box was.
- **Reference car:** the same model as a ghost: every mesh uses one flat translucent `MeshLambertMaterial` in the comparison colour (opacity 0.5, no depth write). It is cheaper than the textured PBR materials (no texture fetches), it keeps the legend (the comparison colour marks the reference, as the box did) and it reads as another car next to the lap car's livery. Known weakness: with no depth write, a translucent car shows its inside where parts overlap; it was not checked by eye. The lap car loses the "you" colour of its box; the livery stands out instead.
- **Lighting:** the scene's hemisphere and directional lights stay as they are. The model's PBR materials get a small generated environment map (three's `RoomEnvironment` through `PMREMGenerator`, made on first use, no HDR download) at intensity 0.55, set on the model's own materials only, so the road and kerbs look as before.

## Performance

Not measured in a browser. From the file:

| | Box cars | Two model cars |
|---|---|---|
| Draw calls for the cars | 4 | about 82 (41 each; 13 meshes per car are transparent glass and light covers) |
| Triangles for the cars | 48 | about 230,000 |

Plus the scene's own roughly 9 calls (ribbon, kerbs, six lines; the verge and sky only in the cockpit view). To measure it: open the 3D view with `?debug` and run the benchmark (follow, scrub and orbit; `bench.ts`). The HUD shows the draw calls and triangles. If it falls short of 60 fps: raise `--ratio` down to 0.15, make the ghost one merged mesh, or show the ghost as the box.

Bundle: the Car popover (Radix popover plus the store) adds about 35 kB (13 kB gzip) to the main bundle (487 to 522 kB); the model parser itself stays in the lazy chunk (the popover imports it on demand). The lazy `threeRibbon` chunk went from 31.8 kB to 107.2 kB (9.2 to 31.5 kB gzip), the shared three.js chunk from 583.5 to 616.2 kB (147.0 to 154.8 kB gzip), because of `GLTFLoader`, the meshopt decoder and `RoomEnvironment`. The main bundle changed by 50 bytes.

## What was not verified

The in-browser converter in a real browser: the module worker and its lazy imports loading from the built chunks, the inline WASM, `OffscreenCanvas` WebP output, drag-and-drop of a folder, and a real Sketchfab folder or zip (the pipeline is tested in node on a generated glTF with the texture encoder stubbed, because `OffscreenCanvas` and `createImageBitmap` don't exist there; the script's `sharp` path was run once on that generated glTF). Memory and time on a 46 MB / 473k-triangle source are unmeasured. The popover itself in a browser (layout, focus handling, the native file picker, IndexedDB persistence across reloads, a real model going in and out live); a stored model's Rotate 180° on screen; the 30 MB path with a real large file. Tests cover them with jsdom, an in-memory store, fake-indexeddb and fake loaders only. How the model looks (livery, simplified shapes, the ghost, lighting, glass); whether it faces forward in the real view (checked on the source geometry, not on screen); the frame rate; the WebP textures decoding in the browser (three's loader parsed the file with the image decode stubbed).

## Recommendation (for the user to decide)

- **Keep** the loader and the folder convention: they cost 22 kB gzip in the lazy chunk, do nothing when no file is there, and cannot leak a model into the repo. Keep the conversion script.
- **Drop** this candidate as anything the repo ships, and **change** nothing else until a model with a clean provenance is found. If the user is content to use it privately, the app already does.
- Open question for the user: whether the 2 x 41 draw calls hold 60 fps on their machine.
