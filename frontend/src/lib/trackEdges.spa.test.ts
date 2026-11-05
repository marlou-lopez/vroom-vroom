/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SpaRecording } from "../api/mock/recording";
import { edgeHalfWidths, kerbRuns, type EdgeLap } from "./trackEdges";

const REC = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../public/mock/spa-2026-11-03.json", import.meta.url)), "utf8"),
) as SpaRecording;
const N = 6980;
const lapsOf = (nos: number[]): EdgeLap[] =>
  nos.map((no) => REC.laps.find((l) => l.lap_no === no)!).map((l) => ({ pathLateral: l.path_lateral, trackEdge: l.track_edge, kerb: l.kerb }));
const pct = (m: Uint8Array) => (100 * m.reduce((a, b) => a + b, 0)) / m.length;
/** Longest run of unmeasured indices (not wrapping). */
function longestGap(m: Uint8Array): number {
  let best = 0, cur = 0;
  for (const v of m) { cur = v ? 0 : cur + 1; best = Math.max(best, cur); }
  return best;
}

describe("track edges on the Spa recording", () => {
  const e = edgeHalfWidths(lapsOf([1, 2, 3, 4]), N);

  it("each side is measured on at least half of the lap with flying laps 1-4", () => {
    expect(pct(e.leftMeasured)).toBeGreaterThanOrEqual(50);
    expect(pct(e.rightMeasured)).toBeGreaterThanOrEqual(50);
  });

  it("all half-widths are finite and between 2 m and 15 m", () => {
    for (const v of [...e.left, ...e.right]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(15);
    }
  });

  it("summary for the write-up", () => {
    const f = (nos: number[]) => {
      const x = edgeHalfWidths(lapsOf(nos), N);
      return `${pct(x.leftMeasured).toFixed(1)}/${pct(x.rightMeasured).toFixed(1)}`;
    };
    const k = kerbRuns(lapsOf([1, 2, 3, 4]), N);
    console.log(
      `measured L/R %: laps 3,4 ${f([3, 4])}; laps 1-4 ${f([1, 2, 3, 4])}; laps 0-6 ${f([0, 1, 2, 3, 4, 5, 6])}; ` +
      `longest filled gap (laps 1-4) L ${longestGap(e.leftMeasured)} m, R ${longestGap(e.rightMeasured)} m; ` +
      `kerb runs L ${k.filter((r) => r.side === "left").length}, R ${k.filter((r) => r.side === "right").length}`,
    );
  });
});
