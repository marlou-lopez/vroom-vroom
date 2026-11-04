/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Corner, TrackMap } from "../api/types";
import type { SpaRecording, SpaRecordingLap } from "../api/mock/recording";
import { deriveLandmarks, spaCorners, SPA_TRACK_LENGTH_M } from "../api/mock/spaTrack";
import { originOf, toLocalMetres, type XY } from "./geo";
import {
  centreline, distStats, lateralOffsets, lineFromGps, lineFromLateral, LATERAL_LIMIT_M, normalsLeft, pointDistances, straightMask,
} from "./racingLine";

const REC = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../public/mock/spa-2026-11-03.json", import.meta.url)), "utf8"),
) as SpaRecording;
const lap = (no: number) => REC.laps.find((l) => l.lap_no === no)!;
const FLYING = [1, 2, 3, 4];
const ref = lap(4);
const corners = spaCorners(ref);
const MAP: TrackMap = { track_id: "spa", length_m: SPA_TRACK_LENGTH_M, corners, landmarks: deriveLandmarks(corners, ref) };
const origin = originOf(ref.lat, ref.lon);
const xyOf = (l: SpaRecordingLap): XY => toLocalMetres(l.lat, l.lon, origin);
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Index set covering the given corners' [start_m, end_m]. */
function rangeMask(cs: Corner[], n: number): boolean[] {
  const m = new Array<boolean>(n).fill(false);
  for (const c of cs) for (let i = Math.max(0, c.start_m); i <= Math.min(n - 1, c.end_m); i++) m[i] = true;
  return m;
}
const span = (cs: Corner[]) => `${cs.map((c) => c.id).join("+")} ${Math.min(...cs.map((c) => c.start_m))}-${Math.max(...cs.map((c) => c.end_m))} m`;
const byId = (...ids: string[]) => corners.filter((c) => ids.includes(c.id));

/** Index runs where the predicate holds, e.g. "0-412, 6900-6978". */
function runs(flag: boolean[]): string {
  const out: string[] = [];
  let s = -1;
  for (let i = 0; i <= flag.length; i++) {
    const on = i < flag.length && flag[i];
    if (on && s < 0) s = i;
    if (!on && s >= 0) { out.push(`${s}-${i - 1}`); s = -1; }
  }
  return out.length ? out.join(", ") : "none";
}

describe("racing line maths on the Spa recording", () => {
  const laps = FLYING.map((no) => ({ no, xy: xyOf(lap(no)), pl: lap(no).path_lateral }));
  const centre = centreline(laps.map((l) => ({ xy: l.xy, pathLateral: l.pl })));
  const n = centre.x.length;
  const straights = straightMask(MAP, n);
  const rai = rangeMask(byId("eaurouge", "raidillon"), n);
  const bus = rangeMask(byId("busstop"), n);

  it("implied centres of laps 1-4 agree to < 0.2 m rms (path_lateral > 0 = right)", () => {
    const nl = normalsLeft(centre);
    const nlx = (i: number) => nl.x[i], nly = (i: number) => nl.y[i];
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const cx = laps.map((l) => l.xy.x[i] + l.pl[i] * nlx(i)), cy = laps.map((l) => l.xy.y[i] + l.pl[i] * nly(i));
      const mx = cx.reduce((a, b) => a + b, 0) / cx.length, my = cy.reduce((a, b) => a + b, 0) / cy.length;
      acc += cx.reduce((a, v, k) => a + (v - mx) ** 2 + (cy[k] - my) ** 2, 0) / cx.length;
    }
    const rms = Math.sqrt(acc / n);
    console.log(`implied-centre spread rms: ${r2(rms)} m`);
    expect(rms).toBeLessThan(0.2);
  });

  it("lateral line at La Source is no wigglier than GPS smoothed ±4 m (path_lateral is 10 Hz)", () => {
    // Wiggle: rms of the third difference across the line (mm); a smooth curve of any radius gives ~0.
    const wiggle = (p: XY, i0: number, i1: number) => {
      let s = 0;
      for (let i = i0; i < i1; i++) {
        const tx = p.x[i + 1] - p.x[i - 1], ty = p.y[i + 1] - p.y[i - 1], len = Math.hypot(tx, ty);
        const d3x = p.x[i + 2] - 3 * p.x[i + 1] + 3 * p.x[i] - p.x[i - 1];
        const d3y = p.y[i + 2] - 3 * p.y[i + 1] + 3 * p.y[i] - p.y[i - 1];
        s += ((-ty * d3x + tx * d3y) / len) ** 2;
      }
      return Math.sqrt(s / (i1 - i0)) * 1000;
    };
    // The view builds the centreline from the two compared laps; do the same (lap 4 vs lap 3).
    const two = [laps[3], laps[2]];
    const c2 = centreline(two.map((l) => ({ xy: l.xy, pathLateral: l.pl })));
    const lateral = wiggle(lineFromLateral(c2, two[0].pl), 200, 500);
    const gps4 = wiggle(lineFromGps(two[0].xy, 4), 200, 500);
    console.log(`La Source wiggle: lateral ${r2(lateral)} mm, gps ±4 ${r2(gps4)} mm`);
    expect(lateral).toBeLessThan(gps4);
  });

  it("reports the spike numbers", () => {
    console.log(`Ranges used: Raidillon = ${span(byId("eaurouge", "raidillon"))}; Bus Stop = ${span(byId("busstop"))}; ` +
      `straights: ${straights.filter(Boolean).length} of ${n} indices`);

    // (a) method 1 (GPS smoothed) vs method 2 (lateral on shared centre, GPS half 4 as fallback)
    const fallback = laps.map((l) => lineFromGps(l.xy, 4));
    const rows: Record<string, unknown>[] = [];
    laps.forEach((l, k) => {
      const m2 = lineFromLateral(centre, l.pl, fallback[k]);
      for (const half of [0, 2, 4, 8]) {
        const d = pointDistances(lineFromGps(l.xy, half), m2);
        const row: Record<string, unknown> = { lap: l.no, "gps half": half };
        for (const [name, mask] of [["all", undefined], ["straights", straights], ["Raidillon", rai], ["Bus Stop", bus]] as const) {
          const s = distStats(d, mask);
          row[`${name} mean`] = r2(s.mean);
          row[`${name} p95`] = r2(s.p95);
          row[`${name} max`] = r2(s.max);
        }
        rows.push(row);
      }
    });
    console.log("(a) distance between method 1 (gps) and method 2 (lateral), metres");
    console.table(rows);

    // (b) repeatability on straights: per-index spread (max - min) of the four laps' offsets from the shared centre
    const rep = (lines: XY[]) => {
      const offs = lines.map((ln) => lateralOffsets(ln, centre));
      const sp = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let lo = Infinity, hi = -Infinity;
        for (const o of offs) { lo = Math.min(lo, o[i]); hi = Math.max(hi, o[i]); }
        sp[i] = hi - lo;
      }
      return distStats(sp, straights);
    };
    const repRows = [
      ...[0, 2, 4, 8].map((half) => ({ method: `1 gps half ${half}`, ...(() => { const s = rep(laps.map((l) => lineFromGps(l.xy, half))); return { mean: r2(s.mean), p95: r2(s.p95), max: r2(s.max), n: s.n }; })() })),
      { method: "2 lateral", ...(() => { const s = rep(laps.map((l, k) => lineFromLateral(centre, l.pl, fallback[k]))); return { mean: r2(s.mean), p95: r2(s.p95), max: r2(s.max), n: s.n }; })() },
    ];
    console.log("(b) repeatability on straights: spread (max - min) of the 4 laps' lateral offsets, metres");
    console.table(repRows);

    // (c) out-lap and in-lap
    const offRows = [0, 6].map((no) => {
      const pl = lap(no).path_lateral;
      const m = Math.min(pl.length, n);
      const flag = Array.from({ length: m }, (_, i) => Math.abs(pl[i]) > LATERAL_LIMIT_M);
      const cnt = flag.filter(Boolean).length;
      return { lap: no, points: m, "|pl| > 15": cnt, share: r2(cnt / m), "index runs": runs(flag) };
    });
    console.log("(c) share of points using the GPS fallback (|path_lateral| > 15 m)");
    console.table(offRows);
  });
});
