/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Recording } from "../../../api/mock/recording";
import { createMockApi } from "../../../api/mock/mockApi";
import { aidRuns, mapSpan } from "../../../lib/driverAids";
import { offTrackRuns } from "../../../lib/offTrack";
import { buildScene } from "../detailed/scene";
import { buildMarkPositions, ribbonMarks } from "./marks";

const REC = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../public/mock/spa-2026-11-03.json", import.meta.url)), "utf8")) as Recording;

const api = createMockApi({ coachDelayMs: 0, loadSpa: async () => REC });
const session = (await api.sessions()).find((x) => x.started_at.startsWith("2026-11-03"))!;
const laps = await api.sessionLaps(session.session_id);
const id = (no: number) => laps.find((l) => l.lap_no === no)!.lap_id;

describe("ribbon marks on Spa lap 5", async () => {
  const cmp = await api.compare(id(5), id(3));
  const scene = buildScene(cmp, { source: "lateral", gpsHalf: 4, edges: "telemetry" });
  const n = scene.lap.x.length;
  const marks = ribbonMarks(cmp.lap, n, true);
  const aids = aidRuns(cmp.lap);

  it("has the lockup and wheelspin stretches the detailed 2D map draws", () => {
    expect(aids.lockup.length + aids.wheelspin.length).toBeGreaterThan(0);
    expect(marks.lockup).toEqual(aids.lockup.map((r) => mapSpan(r, n - 1)));
    expect(marks.wheelspin).toEqual(aids.wheelspin.map((r) => mapSpan(r, n - 1)));
    // The same points as the 2D scene's slices.
    expect(marks.lockup.map(([a, b]) => b - a + 1)).toEqual(scene.slip.lockup.map((s) => s.x.length));
    expect(marks.wheelspin.map(([a, b]) => b - a + 1)).toEqual(scene.slip.wheelspin.map((s) => s.x.length));
  });

  it("builds line positions at each grid index's height, with the lift", () => {
    const heights = Float64Array.from({ length: n }, (_, i) => i * 0.01);
    const span = (marks.lockup[0] ?? marks.wheelspin[0])!;
    const p = buildMarkPositions(scene.lap, heights, span, 0.1);
    expect(p.length).toBe((span[1] - span[0] + 1) * 3);
    expect(p[1]).toBeCloseTo(span[0] * 0.01 + 0.1, 4); // y is up
    expect(p[p.length - 2]).toBeCloseTo(span[1] * 0.01 + 0.1, 4);
  });

  it("marks wheels-off stretches at the distances lib/offTrack gives, red only on an invalid lap", () => {
    const ch = { ...cmp.lap, wheels_off: Array.from({ length: n }, (_, i) => ((i >= 100 && i <= 140) || i === 400 ? 3 : 0)) };
    const m = ribbonMarks(ch, n, false);
    expect(m.offTrack).toEqual(offTrackRuns(ch).map((r) => mapSpan(r, n - 1)));
    expect(m.offTrack[0][0]).toBe(100);
    expect(m.offTrack.length).toBe(2);
    expect(m.invalid).toBe(true);
    expect(ribbonMarks(ch, n, true).invalid).toBe(false);
    expect(ribbonMarks(ch, n, undefined).invalid).toBe(false);
  });

  it("a lap with no wheels off, no lockup and no wheelspin has no marks", () => {
    const zero = (v: number) => new Array<number>(n).fill(v);
    const clean = { ...cmp.lap, wheels_off: zero(0), brake: zero(0), throttle: zero(0), abs: zero(0), tc: zero(0), slip_fl: zero(1), slip_fr: zero(1), slip_rl: zero(1), slip_rr: zero(1) };
    expect(ribbonMarks(clean, n, false)).toEqual({ lockup: [], wheelspin: [], offTrack: [], invalid: true });
  });
});
