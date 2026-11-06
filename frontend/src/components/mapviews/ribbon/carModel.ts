import { Box3, Color, Group, Mesh, MeshLambertMaterial, type Material, type Object3D, type Texture } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { CarDims } from "../../../api/types";
import { visualForwardM } from "../detailed/renderer";
import { carModelStore, modelUrl, type CarModelStore } from "./carModelStore";

/**
 * Optional real 3D car models (#102, experimental). Per car_id the 3D view looks for, in order: the user's own model kept in
 * this browser (`carModelStore`, loaded through the car popover), then `public/local-models/<car_id>.glb` (a developer
 * convenience, git-ignored: model licences usually forbid redistribution), then it keeps the box.
 */

export interface V3 { x: number; y: number; z: number }
export interface Bounds { min: V3; max: V3 }

export interface ModelFit {
  /** Rotation about the vertical (radians) that puts the model's long axis along z. */
  yaw: number;
  /** Uniform scale from the model's units to metres. */
  scale: number;
  /** Where the (yawed, then scaled) model sits: its centre in x, its visual centre (forward shift) in z, its lowest point on the road (y = 0). */
  position: V3;
  /** The model's native size (before scale) and its size in metres after the fit, as width (x), height (y), length (z). */
  nativeSize: V3;
  sizeM: V3;
}

/**
 * Scale and place a model whose axis-aligned bounds are `b` (y up, tyres at the lowest point). The long horizontal axis is
 * taken as the car's length: z already means the nose is +z; a model long along x is turned by -90 degrees about y (+x onto +z).
 * The scale makes the length equal `dims.length_m` (the sheet length; the width then follows the model's own proportions).
 * The footprint is centred on the visual centre, `visualForwardM(dims)` ahead of the recorded point, like the box.
 * `rotate180` turns the model a further half turn about the vertical, for models whose nose is at -z (or -x).
 */
export function fitModel(b: Bounds, dims: CarDims, rotate180 = false): ModelFit {
  const size = { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z };
  const alongX = size.x > size.z;
  let yaw = alongX ? -Math.PI / 2 : 0;
  // Bounds after the yaw: (x, z) -> (-z, x) when turned by -90 degrees.
  const y0 = b.min.y;
  let cx = alongX ? -(b.min.z + b.max.z) / 2 : (b.min.x + b.max.x) / 2;
  let cz = alongX ? (b.min.x + b.max.x) / 2 : (b.min.z + b.max.z) / 2;
  if (rotate180) { yaw += Math.PI; cx = -cx; cz = -cz; }
  const width = alongX ? size.z : size.x, length = alongX ? size.x : size.z;
  const scale = length > 0 ? dims.length_m / length : 1;
  return {
    yaw, scale,
    position: { x: -cx * scale, y: -y0 * scale, z: visualForwardM(dims) - cz * scale },
    nativeSize: { x: width, y: size.y, z: length },
    sizeM: { x: width * scale, y: size.y * scale, z: length * scale },
  };
}

/** A parsed model and its native bounds. Never mutate `root`: cars use clones that share its geometry, materials and textures. */
export interface CarModel { root: Object3D; bounds: Bounds; rotate180: boolean }

export interface ModelLoader {
  loadAsync(url: string): Promise<{ scene: Object3D }>;
  parseAsync?(data: ArrayBuffer, path: string): Promise<{ scene: Object3D }>;
}

export { modelUrl };

let defaultLoader: ModelLoader | null = null;
function gltfLoader(): ModelLoader {
  if (!defaultLoader) {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    defaultLoader = l;
  }
  return defaultLoader;
}

const cache = new Map<string, Promise<CarModel | null>>();

/** Forgets the cached loads (tests). */
export function clearCarModelCache(): void { cache.clear(); }

function measure(scene: Object3D, rotate180: boolean): CarModel | null {
  scene.updateMatrixWorld(true);
  const box = new Box3().setFromObject(scene);
  if (box.isEmpty()) return null;
  return { root: scene, bounds: { min: { ...box.min }, max: { ...box.max } }, rotate180 };
}

/**
 * Parses GLB bytes (the user's file). Throws when they are not a usable glTF binary: the popover uses this to validate a file
 * before storing it.
 */
export async function parseGlb(bytes: ArrayBuffer, rotate180 = false, loader?: ModelLoader): Promise<CarModel> {
  const l = loader ?? gltfLoader();
  if (!l.parseAsync) throw new Error("This loader cannot parse bytes");
  const gltf = await l.parseAsync(bytes, "");
  const m = measure(gltf.scene, rotate180);
  if (!m) throw new Error("The model has no geometry");
  return m;
}

/**
 * The model for `carId`, or null when there is none or it fails to load (404, the dev server's HTML fallback, a corrupt file...):
 * the caller keeps the box, silently. Order: the user's stored model, then `/local-models/<car_id>.glb`. One load per car_id,
 * kept until `invalidateCarModel`.
 */
export function loadCarModel(carId: string, loader?: ModelLoader, store?: CarModelStore): Promise<CarModel | null> {
  const hit = cache.get(carId);
  if (hit) return hit;
  const p = (async (): Promise<CarModel | null> => {
    try {
      const stored = await (store ?? carModelStore()).get(carId);
      if (stored) {
        try { return await parseGlb(stored.bytes, stored.rotate180, loader); } catch { /* unreadable: fall through to the folder */ }
      }
    } catch { /* storage unavailable */ }
    try {
      const gltf = await (loader ?? gltfLoader()).loadAsync(modelUrl(carId));
      return measure(gltf.scene, false);
    } catch {
      return null;
    }
  })();
  cache.set(carId, p);
  return p;
}

/** Drops the cached load of `carId` (its stored model changed) and frees the old model's GPU resources. Detach its instances first. */
export function invalidateCarModel(carId: string): void {
  const old = cache.get(carId);
  cache.delete(carId);
  void old?.then((m) => { if (m) disposeModel(m.root); }, () => undefined);
}

/** Frees the geometry, materials and textures of a parsed model (its clones share them). */
export function disposeModel(root: Object3D): void {
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      if (!mat) continue;
      for (const v of Object.values(mat)) if (v && (v as Texture).isTexture) (v as Texture).dispose();
      mat.dispose();
    }
  });
}

/** The environment-map intensity the model's PBR materials get (the scene's lights are already strong). */
const ENV_INTENSITY = 0.55;
const GHOST_OPACITY = 0.5;

export interface PlacedModel { group: Group; fit: ModelFit; ownMaterial: Material | null }

/**
 * A car-sized instance of `model`: a clone sharing geometry, materials and textures, wrapped in a group that scales, turns and
 * places it per `fitModel`. With `ghost`, every mesh uses one flat translucent material in that colour instead (the reference
 * car): cheaper than the textured PBR materials, and it reads as "the other car" next to the lap car's livery.
 */
export function placeModel(model: CarModel, dims: CarDims, env: Texture | null, ghost?: string): PlacedModel {
  const fit = fitModel(model.bounds, dims, model.rotate180);
  const group = new Group();
  const inner = model.root.clone(true);
  let own: Material | null = null;
  if (ghost) {
    own = new MeshLambertMaterial({ color: new Color(ghost), transparent: true, opacity: GHOST_OPACITY, depthWrite: false });
  }
  inner.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    if (own) { m.material = own; return; }
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const std = mat as Material & { envMap?: Texture | null; envMapIntensity?: number };
      if ("envMapIntensity" in std) { std.envMap = env; std.envMapIntensity = ENV_INTENSITY; }
    }
  });
  group.add(inner);
  group.scale.setScalar(fit.scale);
  group.rotation.y = fit.yaw;
  group.position.set(fit.position.x, fit.position.y, fit.position.z);
  return { group, fit, ownMaterial: own };
}
