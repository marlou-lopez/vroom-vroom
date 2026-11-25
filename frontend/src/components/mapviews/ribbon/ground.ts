// Ground texture beside the track (vroom-ueg.9, experimental): the tiles' manifest and the terrain mesh under them. Pure logic, no three.js.
// The tiles come from tools/aerial-edges (`run.py ground <track>`), in a git-ignored folder, and lie in LMU's world frame (x east, z north).
import type { XY } from "../../../lib/geo";
import { toLocalMetres } from "../../../lib/geo";
import { worldToLatLon } from "../../../lib/elevation";

export interface GroundTile { file: string; /** South-west corner, world metres. */ x: number; z: number; /** Pixels per side. */ px: number }
export interface GroundManifest { attribution: string; licence_url: string | null; tile_m: number; reach_m: number; tiles: GroundTile[] }

export const groundUrl = (trackId: string) => `/local-ground/${encodeURIComponent(trackId)}/`;

/** The manifest, or null when `v` is not one (Vite answers a missing file with the app's own page). */
export function parseGround(v: unknown): GroundManifest | null {
  const m = v as (Partial<GroundManifest> & { version?: number }) | null;
  if (typeof m !== "object" || m === null || m.version !== 1) return null;
  const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  if (typeof m.attribution !== "string" || !m.attribution || !num(m.tile_m) || m.tile_m <= 0 || m.tile_m % GRID_M !== 0 || !num(m.reach_m)) return null;
  if (!Array.isArray(m.tiles) || !m.tiles.every((t) => t && /^[-\w]+\.jpg$/.test(t.file) && num(t.x) && num(t.z) && num(t.px))) return null;
  return { attribution: m.attribution, licence_url: m.licence_url || null, tile_m: m.tile_m, reach_m: m.reach_m, tiles: m.tiles };
}

export async function loadGround(trackId: string, signal?: AbortSignal): Promise<GroundManifest | null> {
  try {
    const res = await fetch(groundUrl(trackId) + "ground.json", { signal });
    return res.ok ? parseGround(await res.json()) : null;
  } catch {
    return null;
  }
}

/** What the textures take on the GPU: RGBA with mipmaps. */
export const textureBytes = (tiles: readonly { px: number }[]) => tiles.reduce((a, t) => a + (t.px * t.px * 4 * 4) / 3, 0);

/** Spacing of the terrain mesh's grid (m). */
export const GRID_M = 4;
/** The ground stays at least this far (m, before the exaggeration) below the road and the kerbs. */
export const GROUND_DROP_M = 0.05;
/** Closer to the centreline than this the ground is level with the nearest metre of track; beyond BLEND_TO_M it is a smooth mix of all track heights around. */
const BLEND_FROM_M = 12, BLEND_TO_M = 45;
/** The mix takes one centreline point per this many metres. */
const MIX_STEP = 16;
const MIX_SOFT_M2 = 20 * 20;
/** The ground fades out over the last part of the corridor. */
const FADE_FROM = 0.75;
/** The ground is carved under the road and this far (m) beyond its edges, where the kerbs are. */
const KERB_MARGIN_M = 1.5;

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(Math.max((v - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** Terrain heights on one world grid of GRID_M, so neighbouring tiles share their border exactly. */
export interface Terrain {
  /** Height (m) and opacity (0..1) at grid node (column i, row k) = world (i, k) * GRID_M. */
  height(i: number, k: number): number;
  alpha(i: number, k: number): number;
  /** Height of the drawn surface at a world point (its two triangles per cell). */
  at(x: number, z: number): number;
}

/** Scene metres (x east, y north) to world metres: both frames are axis-parallel, only the east scale and the offsets differ. */
export function sceneFrame(origin: { lat0: number; lon0: number }) {
  const at = (x: number, z: number) => {
    const p = worldToLatLon(x, z);
    const q = toLocalMetres([p.lat], [p.lon], origin);
    return { x: q.x[0], y: q.y[0] };
  };
  const o = at(0, 0), e = at(1000, 1000);
  const kx = (e.x - o.x) / 1000, ky = (e.y - o.y) / 1000;
  return {
    toScene: (x: number, z: number) => ({ x: o.x + kx * x, y: o.y + ky * z }),
    toWorld: (x: number, y: number) => ({ x: (x - o.x) / kx, z: (y - o.y) / ky }),
  };
}

export interface TrackLines { centre: XY; edges: [XY, XY]; origin: { lat0: number; lon0: number } }

/**
 * The ground beside the track. Its height is not known there (recordings and captures only cover the driven line), so it is
 * level with the nearest metre of track close by and an inverse-distance mix of the track heights further out, then pushed down wherever it would
 * poke through the road or the kerbs. Nothing outside the tiles is computed.
 */
export function buildTerrain(track: TrackLines, heights: ArrayLike<number>, tiles: readonly GroundTile[], tileM: number, reachM: number): Terrain {
  const frame = sceneFrame(track.origin);
  const n = Math.min(track.centre.x.length, heights.length);
  const cx = new Float64Array(n), cz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = frame.toWorld(track.centre.x[i], track.centre.y[i]);
    cx[i] = w.x; cz[i] = w.z;
  }
  // Nearest centreline point within BLEND_TO_M, through a coarse hash of the points.
  const CELL = BLEND_TO_M;
  const cells = new Map<number, number[]>();
  const keyOf = (a: number, b: number) => a * 100_000 + b;
  for (let i = 0; i < n; i++) {
    const key = keyOf(Math.floor(cx[i] / CELL), Math.floor(cz[i] / CELL));
    const c = cells.get(key);
    if (c) c.push(i); else cells.set(key, [i]);
  }
  const nearest = (x: number, z: number): { d: number; h: number } | null => {
    const a = Math.floor(x / CELL), b = Math.floor(z / CELL);
    let best = BLEND_TO_M * BLEND_TO_M, at = -1;
    for (let p = a - 1; p <= a + 1; p++) for (let q = b - 1; q <= b + 1; q++) {
      for (const i of cells.get(keyOf(p, q)) ?? []) {
        const d = (cx[i] - x) ** 2 + (cz[i] - z) ** 2;
        if (d < best) { best = d; at = i; }
      }
    }
    return at < 0 ? null : { d: Math.sqrt(best), h: heights[at] };
  };

  let i0 = Infinity, i1 = -Infinity, k0 = Infinity, k1 = -Infinity;
  const per = tileM / GRID_M;
  for (const t of tiles) {
    i0 = Math.min(i0, t.x / GRID_M); i1 = Math.max(i1, t.x / GRID_M + per);
    k0 = Math.min(k0, t.z / GRID_M); k1 = Math.max(k1, t.z / GRID_M + per);
  }
  const w = tiles.length ? i1 - i0 + 1 : 0, rows = tiles.length ? k1 - k0 + 1 : 0;
  const h = new Float32Array(w * rows).fill(NaN), alpha = new Float32Array(w * rows);
  for (const t of tiles) {
    for (let a = 0; a <= per; a++) for (let b = 0; b <= per; b++) {
      const i = t.x / GRID_M + a, k = t.z / GRID_M + b, s = (k - k0) * w + (i - i0);
      if (!Number.isNaN(h[s])) continue;
      const x = i * GRID_M, z = k * GRID_M;
      let sw = 0, sh = 0, min = Infinity;
      for (let m = 0; m < n; m += MIX_STEP) {
        const d2 = (cx[m] - x) ** 2 + (cz[m] - z) ** 2;
        if (d2 < min) min = d2;
        const g = 1 / (d2 + MIX_SOFT_M2) ** 2;
        sw += g; sh += g * heights[m];
      }
      // `min` is from the sparse points, at most MIX_STEP / 2 m too far.
      const near = min < (BLEND_TO_M + MIX_STEP) ** 2 ? nearest(x, z) : null;
      const mix = sw > 0 ? sh / sw : 0;
      const f = near ? smoothstep(BLEND_FROM_M, BLEND_TO_M, near.d) : 1;
      h[s] = (near ? near.h * (1 - f) + mix * f : mix) - GROUND_DROP_M;
      alpha[s] = 1 - smoothstep(reachM * FADE_FROM, reachM, Math.sqrt(min));
    }
  }

  const slot = (i: number, k: number) => (i < i0 || i > i1 || k < k0 || k > k1 ? -1 : (k - k0) * w + (i - i0));
  const height = (i: number, k: number) => { const s = slot(i, k); return s < 0 ? NaN : h[s]; };
  /** The cell's diagonal runs from its south-west to its north-east corner, as in `buildGroundTile`. */
  const at = (x: number, z: number) => {
    const i = Math.floor(x / GRID_M), k = Math.floor(z / GRID_M);
    const u = x / GRID_M - i, v = z / GRID_M - k;
    const sw = height(i, k), se = height(i + 1, k), nw = height(i, k + 1), ne = height(i + 1, k + 1);
    return u >= v ? sw + (se - sw) * u + (ne - se) * v : sw + (nw - sw) * v + (ne - nw) * u;
  };

  // Carve: every metre, across the road and a kerb's width beyond both edges. Lowering a cell can only lower its neighbours' shared corners, so one pass is enough.
  const [le, re] = track.edges;
  for (let i = 0; i < Math.min(n, le.x.length, re.x.length); i++) {
    const l = frame.toWorld(le.x[i], le.y[i]), r = frame.toWorld(re.x[i], re.y[i]);
    const len = Math.hypot(r.x - l.x, r.z - l.z) || 1;
    const ux = (r.x - l.x) / len, uz = (r.z - l.z) / len;
    for (let d = -KERB_MARGIN_M; d <= len + KERB_MARGIN_M; d += 1) {
      const x = l.x + ux * d, z = l.z + uz * d;
      const over = at(x, z) - (heights[i] - GROUND_DROP_M);
      if (!(over > 0)) continue;
      const a = Math.floor(x / GRID_M), b = Math.floor(z / GRID_M);
      for (const [p, q] of [[a, b], [a + 1, b], [a, b + 1], [a + 1, b + 1]]) {
        const s = slot(p, q);
        if (s >= 0) h[s] -= over;
      }
    }
  }
  return { height, alpha: (i, k) => { const s = slot(i, k); return s < 0 ? 0 : alpha[s]; }, at };
}

export interface GroundMesh { positions: Float32Array; uvs: Float32Array; colors: Float32Array; indices: Uint32Array }

/**
 * One tile's mesh: three.js axes, heights unexaggerated, the image's first row at the north side (uv v = 0, textures not flipped), white vertex
 * colours with the fade as alpha. Cells that are fully faded out are left out. Faces point up.
 */
export function buildGroundTile(tile: GroundTile, tileM: number, terrain: Terrain, origin: { lat0: number; lon0: number }): GroundMesh {
  const frame = sceneFrame(origin);
  const per = tileM / GRID_M, side = per + 1;
  const positions = new Float32Array(side * side * 3), uvs = new Float32Array(side * side * 2), colors = new Float32Array(side * side * 4);
  const idx: number[] = [];
  const i0 = tile.x / GRID_M, k0 = tile.z / GRID_M;
  for (let b = 0; b < side; b++) for (let a = 0; a < side; a++) {
    const s = b * side + a;
    const p = frame.toScene(tile.x + a * GRID_M, tile.z + b * GRID_M);
    positions.set([p.x, terrain.height(i0 + a, k0 + b), -p.y], 3 * s);
    uvs.set([a / per, 1 - b / per], 2 * s);
    colors.set([1, 1, 1, terrain.alpha(i0 + a, k0 + b)], 4 * s);
    if (a === per || b === per) continue;
    const sw = s, se = s + 1, nw = s + side, ne = nw + 1;
    if ([[a, b], [a + 1, b], [a, b + 1], [a + 1, b + 1]].some(([p2, q]) => terrain.alpha(i0 + p2, k0 + q) > 0)) idx.push(sw, se, ne, sw, ne, nw);
  }
  return { positions, uvs, colors, indices: Uint32Array.from(idx) };
}

