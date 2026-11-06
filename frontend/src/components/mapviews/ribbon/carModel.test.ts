import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CarDims } from "../../../api/types";
import { clearCarModelCache, fitModel, invalidateCarModel, loadCarModel, modelUrl, parseGlb, placeModel } from "./carModel";
import { createMemoryCarModelStore } from "./carModelStore";

const DIMS: CarDims = { length_m: 4.664, width_m: 2.04, visual_offset: { forward_m: 0.0745, up_m: -0.3335 } };
const b = (min: [number, number, number], max: [number, number, number]) => ({ min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] } });

describe("fitModel", () => {
  it("scales the length to the sheet length and keeps the model's own proportions for the width", () => {
    // A model in odd units (0.01 m): 0.0476 long, 0.0212 wide, 0.012 high, nose +z, tyres at y = -0.0001.
    const fit = fitModel(b([-0.0106, -0.0001, -0.0238], [0.0106, 0.0119, 0.0238]), DIMS);
    expect(fit.yaw).toBe(0);
    expect(fit.sizeM.z).toBeCloseTo(4.664, 9);
    expect(fit.scale).toBeCloseTo(4.664 / 0.0476, 6);
    expect(fit.sizeM.x).toBeCloseTo(0.0212 * fit.scale, 9);
    expect(fit.sizeM.y).toBeCloseTo(0.012 * fit.scale, 9);
    expect(fit.nativeSize.z).toBeCloseTo(0.0476, 9);
  });

  it("puts the tyres on the road, the width centred and the length centred on the visual centre ahead of the recorded point", () => {
    const bounds = b([-0.0106, -0.0001, -0.0238], [0.0106, 0.0119, 0.0238]);
    const fit = fitModel(bounds, DIMS);
    const lowest = bounds.min.y * fit.scale + fit.position.y;
    const zMid = ((bounds.min.z + bounds.max.z) / 2) * fit.scale + fit.position.z;
    const xMid = ((bounds.min.x + bounds.max.x) / 2) * fit.scale + fit.position.x;
    expect(lowest).toBeCloseTo(0, 9);
    expect(zMid).toBeCloseTo(0.0745, 9);
    expect(xMid).toBeCloseTo(0, 9);
  });

  it("works for an off-centre model and no visual offset", () => {
    const fit = fitModel(b([1, 2, 10], [3, 3, 15]), { length_m: 5, width_m: 2 });
    expect(fit.scale).toBe(1);
    expect(fit.position).toEqual({ x: -2, y: -2, z: -12.5 });
  });

  it("turns a model that is long along x onto z (-90 degrees about y) and swaps width and length", () => {
    const bounds = b([0, 0, -1], [4, 1.2, 1]); // 4 long along +x, 2 wide
    const fit = fitModel(bounds, { length_m: 2, width_m: 1 });
    expect(fit.yaw).toBeCloseTo(-Math.PI / 2, 12);
    expect(fit.scale).toBe(0.5);
    expect(fit.nativeSize).toEqual({ x: 2, y: 1.2, z: 4 });
    // The model's +x end (the assumed nose) lands on +z, centred on 0: x = 4 -> z = +1 m.
    const yaw = fit.yaw;
    const z = (px: number, pz: number) => (-px * Math.sin(yaw) + pz * Math.cos(yaw)) * fit.scale + fit.position.z;
    expect(z(4, 0)).toBeCloseTo(1, 9);
    expect(z(0, 0)).toBeCloseTo(-1, 9);
  });

  it("does not divide by zero on empty bounds", () => {
    expect(fitModel(b([0, 0, 0], [0, 0, 0]), DIMS).scale).toBe(1);
  });
});

describe("fitModel with rotate180", () => {
  it("turns the model a half turn and keeps it centred on the visual centre with the tyres on the road", () => {
    const bounds = b([-1, 0, -1], [3, 1, 5]); // off-centre, nose +z
    const fit = fitModel(bounds, DIMS, true);
    expect(fit.yaw).toBeCloseTo(Math.PI, 12);
    // After a half turn about y a point (x, z) lands at (-x, -z), then scale and position apply.
    const zs = [bounds.min.z, bounds.max.z].map((z) => -z * fit.scale + fit.position.z);
    const xs = [bounds.min.x, bounds.max.x].map((x) => -x * fit.scale + fit.position.x);
    expect((zs[0] + zs[1]) / 2).toBeCloseTo(0.0745, 9);
    expect((xs[0] + xs[1]) / 2).toBeCloseTo(0, 9);
    expect(fit.sizeM.z).toBeCloseTo(DIMS.length_m, 9);
    expect(fit.position.y).toBeCloseTo(0, 9);
  });
});

describe("stored (user) models", () => {
  beforeEach(() => clearCarModelCache());
  const scene = () => { const g = new Group(); g.add(new Mesh(new BoxGeometry(2, 1, 4), new MeshStandardMaterial())); return g; };
  const rec = { carId: "u", bytes: new ArrayBuffer(12), fileName: "m.glb", size: 12, addedAt: 1, rotate180: true };

  it("prefers the user's stored model over the folder, with its rotate flag", async () => {
    const store = createMemoryCarModelStore();
    await store.put(rec);
    const loadAsync = vi.fn(async () => ({ scene: scene() }));
    const parseAsync = vi.fn(async () => ({ scene: scene() }));
    const m = await loadCarModel("u", { loadAsync, parseAsync }, store);
    expect(parseAsync).toHaveBeenCalledTimes(1);
    expect(loadAsync).not.toHaveBeenCalled();
    expect(m?.rotate180).toBe(true);
  });

  it("falls back to the folder when the stored bytes are unreadable, and to null when there is neither", async () => {
    const store = createMemoryCarModelStore();
    await store.put(rec);
    const parseAsync = async () => { throw new Error("corrupt"); };
    const m = await loadCarModel("u", { loadAsync: async () => ({ scene: scene() }), parseAsync }, store);
    expect(m?.rotate180).toBe(false);
    clearCarModelCache();
    await expect(loadCarModel("u", { loadAsync: async () => { throw new Error("404"); }, parseAsync }, store)).resolves.toBeNull();
  });

  it("invalidateCarModel makes the next load read the store again", async () => {
    const store = createMemoryCarModelStore();
    const loadAsync = vi.fn(async () => ({ scene: scene() }));
    const parseAsync = vi.fn(async () => ({ scene: scene() }));
    const loader = { loadAsync, parseAsync };
    expect((await loadCarModel("u", loader, store))?.rotate180).toBe(false);
    await store.put(rec);
    expect((await loadCarModel("u", loader, store))?.rotate180).toBe(false); // still cached
    invalidateCarModel("u");
    expect((await loadCarModel("u", loader, store))?.rotate180).toBe(true);
  });

  it("parseGlb rejects bytes the loader cannot read and models without geometry", async () => {
    await expect(parseGlb(new ArrayBuffer(4), false, { loadAsync: vi.fn(), parseAsync: async () => { throw new Error("bad"); } })).rejects.toThrow();
    await expect(parseGlb(new ArrayBuffer(4), false, { loadAsync: vi.fn(), parseAsync: async () => ({ scene: new Group() }) })).rejects.toThrow();
  });
});

describe("loadCarModel", () => {
  beforeEach(() => clearCarModelCache());
  const scene = () => { const g = new Group(); g.add(new Mesh(new BoxGeometry(2, 1, 4), new MeshStandardMaterial())); return g; };

  it("returns the scene with its bounds and asks for /local-models/<car_id>.glb", async () => {
    const loadAsync = vi.fn(async () => ({ scene: scene() }));
    const m = await loadCarModel("car_a", { loadAsync });
    expect(loadAsync).toHaveBeenCalledWith(modelUrl("car_a"));
    expect(modelUrl("car_a")).toMatch(/local-models\/car_a\.glb$/);
    expect(m?.bounds).toEqual({ min: { x: -1, y: -0.5, z: -2 }, max: { x: 1, y: 0.5, z: 2 } });
  });

  it("falls back to null, without throwing, when the load fails", async () => {
    const loadAsync = vi.fn(async () => { throw new Error("404"); });
    await expect(loadCarModel("missing", { loadAsync })).resolves.toBeNull();
  });

  it("falls back to null for a model with no geometry", async () => {
    await expect(loadCarModel("empty", { loadAsync: async () => ({ scene: new Group() }) })).resolves.toBeNull();
  });

  it("loads once per car_id, failures included", async () => {
    const ok = vi.fn(async () => ({ scene: scene() }));
    await loadCarModel("c1", { loadAsync: ok });
    await loadCarModel("c1", { loadAsync: ok });
    expect(ok).toHaveBeenCalledTimes(1);
    const bad = vi.fn(async () => { throw new Error("x"); });
    await loadCarModel("c2", { loadAsync: bad });
    await expect(loadCarModel("c2", { loadAsync: bad })).resolves.toBeNull();
    expect(bad).toHaveBeenCalledTimes(1);
  });
});

describe("placeModel", () => {
  const model = async () => (await loadCarModel("p", { loadAsync: async () => { const g = new Group(); g.add(new Mesh(new BoxGeometry(2, 1, 4), new MeshStandardMaterial())); return { scene: g }; } }))!;
  beforeEach(() => clearCarModelCache());

  it("wraps a clone that shares the cached geometry and material, scaled to the car", async () => {
    const m = await model();
    const { group, fit } = placeModel(m, { length_m: 2, width_m: 1 }, null);
    expect(group.scale.x).toBeCloseTo(0.5, 12);
    expect(fit.sizeM.z).toBeCloseTo(2, 12);
    const src = m.root.children[0] as Mesh, copy = group.children[0].children[0] as Mesh;
    expect(copy).not.toBe(src);
    expect(copy.geometry).toBe(src.geometry);
    expect(copy.material).toBe(src.material);
  });

  it("as a ghost, gives every mesh one translucent material of its own and leaves the shared one alone", async () => {
    const m = await model();
    const { group, ownMaterial } = placeModel(m, { length_m: 2, width_m: 1 }, null, "#ff8800");
    const copy = group.children[0].children[0] as Mesh;
    expect(copy.material).toBe(ownMaterial);
    expect((ownMaterial as { transparent: boolean }).transparent).toBe(true);
    expect((m.root.children[0] as Mesh).material).not.toBe(ownMaterial);
  });
});
