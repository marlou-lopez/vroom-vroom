# Local car models (developer fallback)

**Everything here except this README is git-ignored and must never be committed**: the repo is public, and most downloadable car models cannot be redistributed.

**The preferred way is in the app:** open the 3D view, press **Car**, and choose the model: a `.glb`, a `.zip`, or the folder of a raw download (`scene.gltf`, `scene.bin`, `textures/`), or drop one onto the car. The app converts and shrinks it in your browser (no Node or terminal needed) and keeps the result in your browser only (IndexedDB). It is never uploaded or written to this folder.

This folder is a developer fallback. If you have no model loaded in the app, the 3D view looks for `/local-models/<car_id>.glb` (for example `mclaren_720s_gt3_evo.glb`, using the `car_id` from the API). Lookup order: your model in the app, then this folder, then the true-size box. If a file is missing or fails to load, the view silently uses the next fallback.

To make a `.glb` for this folder, run the same conversion on the command line (run `npm ci` in `frontend/` once; see `docs/track-views/car-model.md`):

```bash
node tools/optimize-car-model.mjs <source folder, .zip, .gltf or .glb> frontend/public/local-models/<car_id>.glb
```

Only use a model whose licence you have checked yourself and that you are allowed to use.
