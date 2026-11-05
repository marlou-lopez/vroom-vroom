/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SpaRecording } from "../../../api/mock/recording";
import { createMockApi } from "../../../api/mock/mockApi";
import { lateralOffsets } from "../../../lib/racingLine";
import { buildScene } from "./scene";

const REC = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../public/mock/spa-2026-11-03.json", import.meta.url)), "utf8"),
) as SpaRecording;

async function spa(lapNo: number, refNo: number) {
  const api = createMockApi({ coachDelayMs: 0, loadSpa: async () => REC });
  const s = (await api.sessions()).find((x) => x.started_at.startsWith("2026-11-03"))!;
  const laps = await api.sessionLaps(s.session_id);
  const id = (no: number) => laps.find((l) => l.lap_no === no)!.lap_id;
  return api.compare(id(lapNo), id(refNo));
}


describe("telemetry edges on Spa lap 4 vs 3", async () => {
  const cmp = await spa(4, 3);
  const scene = buildScene(cmp, { source: "lateral", gpsHalf: 4, edges: "telemetry" });
  const n = scene.centre.x.length;
  const [left, right] = scene.edges.map((e) => lateralOffsets(e, scene.centre));
  const [lm, rm] = scene.edgeMeasured!;

  const outside = (line: typeof scene.lap) => {
    const off = lateralOffsets(line, scene.centre);
    const c = { measured: [0, 0], filled: [0, 0] }; // [outside, total]
    for (let i = 0; i < n; i++) {
      const measured = off[i] < 0 ? lm[i] : rm[i];
      const bucket = measured ? c.measured : c.filled;
      bucket[1]++;
      if (off[i] < left[i] || off[i] > right[i]) bucket[0]++;
    }
    return c;
  };
  const maxJump = (v: Float64Array) => { let m = 0; for (let i = 1; i < v.length; i++) m = Math.max(m, Math.abs(v[i] - v[i - 1])); return m; };

  it("summary for the write-up", () => {
    const pct = (b: number[]) => (b[1] ? (100 * b[0]) / b[1] : 0).toFixed(1);
    const a = outside(scene.lap), b = outside(scene.ref);
    // left[] is negative (left of the centre), so the half-width jump is the jump of the offsets.
    console.log(
      `edges spa 4v3: outside lap measured ${pct(a.measured)}% (${a.measured[0]}/${a.measured[1]}) filled ${pct(a.filled)}% (${a.filled[0]}/${a.filled[1]}); ` +
      `ref measured ${pct(b.measured)}% (${b.measured[0]}/${b.measured[1]}) filled ${pct(b.filled)}% (${b.filled[0]}/${b.filled[1]}); ` +
      `max jump left ${maxJump(left).toFixed(2)} m right ${maxJump(right).toFixed(2)} m; kerbs ${scene.kerbs.length}`,
    );
    for (const c of [a, b]) {
      if (c.measured[1]) expect(c.measured[0] / c.measured[1]).toBeLessThan(0.1);
    }
  });

  it("is finite and every kerb has at least two points", () => {
    for (const e of scene.edges) for (let i = 0; i < n; i++) { expect(Number.isFinite(e.x[i])).toBe(true); expect(Number.isFinite(e.y[i])).toBe(true); }
    for (const k of scene.kerbs) expect(k.xy.x.length).toBeGreaterThanOrEqual(2);
  });

  it("surface borders follow the real edges and the band is about as wide as the track", () => {
    const [sl, sr] = scene.surface.map((b) => lateralOffsets(b, scene.centre));
    const lines = [lateralOffsets(scene.lap, scene.centre), lateralOffsets(scene.ref, scene.centre)];
    const W = 40;
    const past = (side: 0 | 1, i: number) => {
      for (let k = -W; k <= W; k++) {
        const j = (i + k + n) % n;
        for (const o of lines) if (side === 0 ? o[j] < left[j] : o[j] > right[j]) return true;
      }
      return false;
    };
    for (let i = 0; i < n; i++) {
      if (!past(0, i)) expect(-sl[i]).toBeLessThanOrEqual(-left[i] + 0.01);
      if (!past(1, i)) expect(sr[i]).toBeLessThanOrEqual(right[i] + 0.01);
    }
    let band = 0, track = 0;
    for (let i = 0; i < n; i++) { band += sr[i] - sl[i]; track += right[i] - left[i]; }
    console.log(`surface band mean ${(band / n).toFixed(2)} m vs edges ${(track / n).toFixed(2)} m`);
    expect(Math.abs(band - track) / n).toBeLessThan(0.3);
  });
});
