import { afterEach, describe, expect, it, vi } from "vitest";
import { worldToLatLon } from "../../../lib/elevation";
import { toLocalMetres } from "../../../lib/geo";
import { GROUND_DROP_M, buildGroundTile, buildTerrain, loadGround, parseGround, sceneFrame, textureBytes, type GroundManifest } from "./ground";

const origin = { lat0: 60.01, lon0: -0.01 };
const manifest = { version: 1, attribution: "credit", licence_url: "https://x", tile_m: 128, reach_m: 60, tiles: [{ file: "0_0.jpg", x: 0, z: 0, px: 512 }] };
const tiles = (parseGround(manifest) as GroundManifest).tiles;

describe("parseGround", () => {
  it("takes a manifest and nothing else", () => {
    expect(parseGround(manifest)).toMatchObject({ attribution: "credit", tile_m: 128 });
    for (const bad of [null, "x", {}, { ...manifest, version: 2 }, { ...manifest, attribution: "" }, { ...manifest, tile_m: 130 },
      { ...manifest, tiles: [{ file: "../a.jpg", x: 0, z: 0, px: 1 }] }]) expect(parseGround(bad)).toBeNull();
  });
});

describe("loadGround", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("is null when the file is missing or is the app's own page", async () => {
    vi.stubGlobal("fetch", async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }));
    expect(await loadGround("spa")).toBeNull();
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    expect(await loadGround("spa")).toBeNull();
    vi.stubGlobal("fetch", async () => Response.json(manifest));
    expect((await loadGround("spa"))?.tiles).toHaveLength(1);
  });
});

it("counts RGBA with mipmaps", () => expect(textureBytes([{ px: 512 }])).toBeCloseTo(1398101, 0));

/** A road along z = 64 from x = 0 to 127, 10 m wide, with the given heights. */
function road(h: (i: number) => number) {
  const line = (z: number) => {
    const p = Array.from({ length: 128 }, (_, i) => worldToLatLon(i, z));
    return toLocalMetres(p.map((q) => q.lat), p.map((q) => q.lon), origin);
  };
  return { track: { centre: line(64), edges: [line(69), line(59)] as [ReturnType<typeof line>, ReturnType<typeof line>], origin }, heights: Float64Array.from({ length: 128 }, (_, i) => h(i)) };
}

describe("sceneFrame", () => {
  it("is the scene's own lat/lon projection, and inverts", () => {
    const f = sceneFrame(origin);
    const p = worldToLatLon(1234, -987);
    const q = toLocalMetres([p.lat], [p.lon], origin);
    const s = f.toScene(1234, -987);
    expect(s.x).toBeCloseTo(q.x[0], 3);
    expect(s.y).toBeCloseTo(q.y[0], 3);
    const w = f.toWorld(s.x, s.y);
    expect(w.x).toBeCloseTo(1234, 6);
    expect(w.z).toBeCloseTo(-987, 6);
  });
});

describe("buildTerrain", () => {
  it("lies level with a flat road, just below it, and fades out at the reach", () => {
    const { track, heights } = road(() => 7);
    const t = buildTerrain(track, heights, tiles, 128, 60);
    expect(t.at(50, 64)).toBeCloseTo(7 - GROUND_DROP_M, 4);
    expect(t.at(50, 120)).toBeCloseTo(7 - GROUND_DROP_M, 4);
    expect(t.alpha(10, 16)).toBe(1);
    expect(t.alpha(10, 31)).toBe(0);
    expect(t.alpha(99, 0)).toBe(0);
  });

  it("never pokes through the road, on a sharp dip either", () => {
    const { track, heights } = road((i) => Math.abs(i - 63) * 0.3);
    const t = buildTerrain(track, heights, tiles, 128, 60);
    for (let i = 0; i < 127; i++) for (const z of [59, 62, 64, 66, 69]) expect(t.at(i, z)).toBeLessThan(heights[i] + 0.01);
  });
});

describe("buildGroundTile", () => {
  const { track, heights } = road(() => 0);
  const m = buildGroundTile(tiles[0], 128, buildTerrain(track, heights, tiles, 128, 60), origin);

  it("puts the image's first row at the north side", () => {
    expect(Array.from(m.uvs.slice(0, 2))).toEqual([0, 1]);
    expect(m.positions[2]).toBeGreaterThan(m.positions[m.positions.length - 1]); // the first vertex is the southern one: larger three z
  });

  it("faces up, and leaves the faded-out cells away", () => {
    const [a, b, c] = m.indices;
    const p = (i: number) => [m.positions[3 * i], m.positions[3 * i + 2]];
    const [ax, az] = p(a), [bx, bz] = p(b), [cx, cz] = p(c);
    expect((bz - az) * (cx - ax) - (bx - ax) * (cz - az)).toBeGreaterThan(0);
    expect(m.indices.length).toBeLessThan(32 * 32 * 6);
    expect(m.indices.length).toBeGreaterThan(0);
  });
});
