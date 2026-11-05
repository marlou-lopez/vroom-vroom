import type { Kerb } from "../detailed/scene";
import type { XY } from "../../../lib/geo";
import { KERB_STRIPE_M, KERB_W_M } from "../detailed/renderer";
import { writeThree } from "./coords";

export interface MeshData { positions: Float32Array; indices: Uint32Array; vertexCount: number; triangleCount: number }

/** The closing segment (last point back to the first) is added only when the lap's ends are this close (m). */
export const CLOSE_GAP_M = 30;

/**
 * Triangle strip between the left and right edge lines: vertex 2i on the left edge, 2i + 1 on the right, both at
 * `heights[i]` (no banking), three.js axes, heights unexaggerated. Counter-clockwise seen from above, so the faces point up.
 * A lap whose end is within CLOSE_GAP_M of its start gets one more segment, closing the loop.
 */
export function buildRibbonMesh(left: XY, right: XY, heights: Float64Array): MeshData {
  const n = Math.min(left.x.length, right.x.length, heights.length);
  const positions = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    writeThree(positions, 2 * i, left.x[i], left.y[i], heights[i]);
    writeThree(positions, 2 * i + 1, right.x[i], right.y[i], heights[i]);
  }
  const closed = n > 2 && Math.hypot(left.x[n - 1] - left.x[0], left.y[n - 1] - left.y[0]) < CLOSE_GAP_M;
  const segments = Math.max(n - 1, 0) + (closed ? 1 : 0);
  const indices = new Uint32Array(segments * 6);
  for (let i = 0; i < segments; i++) {
    const a = 2 * i, b = 2 * i + 1, c = 2 * ((i + 1) % n), d = 2 * ((i + 1) % n) + 1;
    indices.set([a, b, c, b, d, c], 6 * i);
  }
  return { positions, indices, vertexCount: n * 2, triangleCount: segments * 2 };
}

/**
 * A line's points in three.js axes (x, y, z per point) at `heights[i] + lift`. `heights` may be shorter than the line (the
 * last height holds).
 */
export function buildLinePositions(xy: XY, heights: Float64Array, lift: number): Float32Array {
  const n = xy.x.length;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) writeThree(out, i, xy.x[i], xy.y[i], (heights[Math.min(i, heights.length - 1)] ?? 0) + lift);
  return out;
}

/**
 * Kerb stripes: one quad per metre of the kerb polyline, `kerb.width` (KERB_W_M if unset) wide, coloured red or white by stripe (KERB_STRIPE_M each).
 * Point k lies beside centreline index kerb.start + k, whose height it takes, plus `lift`. `colors` is a flat rgb array per vertex.
 */
export function buildKerbMesh(kerb: Kerb, heights: Float64Array, lift: number, red: [number, number, number], white: [number, number, number]): MeshData & { colors: Float32Array } {
  const m = kerb.xy.x.length;
  const segs = Math.max(m - 1, 0);
  const positions = new Float32Array(segs * 4 * 3);
  const colors = new Float32Array(segs * 4 * 3);
  const indices = new Uint32Array(segs * 6);
  const half = (kerb.width ?? KERB_W_M) / 2;
  const h = (k: number) => (heights[Math.min(kerb.start + k, heights.length - 1)] ?? 0) + lift;
  const normal = (k: number) => {
    const a = Math.max(k - 1, 0), b = Math.min(k + 1, m - 1);
    const tx = kerb.xy.x[b] - kerb.xy.x[a], ty = kerb.xy.y[b] - kerb.xy.y[a];
    const len = Math.hypot(tx, ty) || 1;
    return [-ty / len, tx / len]; // left normal
  };
  for (let k = 0; k < segs; k++) {
    const c = Math.floor(k / KERB_STRIPE_M) % 2 === 0 ? red : white;
    const v = 4 * k;
    for (const [slot, kk, sign] of [[0, k, 1], [1, k, -1], [2, k + 1, 1], [3, k + 1, -1]] as const) {
      const [nx, ny] = normal(kk);
      writeThree(positions, v + slot, kerb.xy.x[kk] + sign * nx * half, kerb.xy.y[kk] + sign * ny * half, h(kk));
      colors.set(c, 3 * (v + slot));
    }
    indices.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], 6 * k);
  }
  return { positions, indices, colors, vertexCount: segs * 4, triangleCount: segs * 2 };
}
