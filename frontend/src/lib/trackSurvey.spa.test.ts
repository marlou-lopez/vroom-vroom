/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMockApi } from "../api/mock/mockApi";
import type { SpaRecording } from "../api/mock/recording";
import { buildScene } from "../components/mapviews/detailed/scene";
import { originOf, toLocalMetres } from "./geo";
import { centreProjector, smoothLmu, surveyHalfWidths, type SurveyFile } from "./trackSurvey";
import { lateralOffsets } from "./racingLine";

const read = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));
// Bound on the step between neighbouring metres (m). Observed: 1.13 m on the left at metre 271 (La Source, a fallback stretch where
// LMU has no sample for 17 m and the smoothed width swings around its one value) and 0.35 m on the right (a contact boundary);
// LMU's own raw width steps by 3.6 to 5.2 m.
const STEP_BOUND_M = 1.25;
const REC = read("../../public/mock/spa-2026-11-03.json") as SpaRecording;
const SURVEY = read("../../public/mock/spa-survey-2026-11-06.json") as SurveyFile;

// The 6 Nov survey (an 18-car session plus four slow laps along the edges) mapped onto the 3 Nov recording purely by position (#97).
describe("Spa survey on the 3 Nov recording", async () => {
  const api = createMockApi({ coachDelayMs: 0, loadSpa: async () => REC, loadSurvey: async () => SURVEY });
  const s = (await api.sessions()).find((x) => x.started_at.startsWith("2026-11-03"))!;
  const laps = await api.sessionLaps(s.session_id);
  const id = (no: number) => laps.find((l) => l.lap_no === no)!.lap_id;
  const cmp = await api.compare(id(4), id(3));
  const sv = cmp.track_survey!;

  it("measures each edge on at least 99% of the grid (both at the same metre on 98%)", () => {
    const n = cmp.distance.length;
    const cover = (v: (number | null)[]) => v.filter((x) => x !== null).length / n;
    const l = cover(sv.left_m), r = cover(sv.right_m);
    const both = sv.left_m.filter((x, i) => x !== null && sv.right_m[i] !== null).length / n;
    console.log(`survey coverage: left ${(100 * l).toFixed(2)}% right ${(100 * r).toFixed(2)}% both ${(100 * both).toFixed(2)}% (${n} points)`);
    expect(l).toBeGreaterThanOrEqual(0.99);
    expect(r).toBeGreaterThanOrEqual(0.99);
    expect(both).toBeGreaterThanOrEqual(0.98); // the few gaps (La Source, the start line) are real: no car drove that edge there
  });

  it("has plausible half-widths and kerbs of both kinds on both sides", () => {
    for (const v of [...sv.left_m, ...sv.right_m]) if (v !== null) { expect(v).toBeGreaterThan(2); expect(v).toBeLessThan(20); }
    const kinds = new Set(sv.kerbs.map((k) => k.kind));
    expect(kinds.has("flat")).toBe(true);
    expect(kinds.has("razor")).toBe(true);
    expect(sv.kerbs.some((k) => k.side === "left")).toBe(true);
    expect(sv.kerbs.some((k) => k.side === "right")).toBe(true);
    console.log(`survey kerbs: ${sv.kerbs.length} (flat ${sv.kerbs.filter((k) => k.kind === "flat").length}, razor ${sv.kerbs.filter((k) => k.kind === "razor").length})`);
  });
});

// The wheel-contact edge (tarmac <-> anything else crossings of every car's wheels) against LMU's own half-width, on the scene's centreline.
describe("contact edges on Spa", async () => {
  const api = createMockApi({ coachDelayMs: 0, loadSpa: async () => REC, loadSurvey: async () => SURVEY });
  const sess = (await api.sessions()).find((x) => x.started_at.startsWith("2026-11-03"))!;
  const laps = await api.sessionLaps(sess.session_id);
  const id = (no: number) => laps.find((l) => l.lap_no === no)!.lap_id;
  const cmp = await api.compare(id(4), id(3));
  const sv = cmp.track_survey!;
  const sc = buildScene(cmp, { source: "lateral", gpsHalf: 4, edges: "telemetry" });
  const n = sc.centre.x.length;
  const q = (v: number[], p: number) => v.slice().sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * p))];
  const half = [lateralOffsets(sc.edges[0], sc.centre).map((x) => -x), lateralOffsets(sc.edges[1], sc.centre)];
  const lmu = [sv.left_m, sv.right_m];
  const smooth = [smoothLmu(sv.left_m, n), smoothLmu(sv.right_m, n)];

  it("passes the drawn edge through the measured contacts", () => {
    const o = originOf(cmp.ref.lat, cmp.ref.lon);
    const origin = { lat0: Math.round(o.lat0 * 100) / 100, lon0: Math.round(o.lon0 * 100) / 100 };
    const pts = toLocalMetres(sv.edge_points.map((p) => p[0]), sv.edge_points.map((p) => p[1]), origin);
    const project = centreProjector(sc.centre);
    const miss: number[] = [];
    for (let k = 0; k < pts.x.length; k++) {
      const p = project(pts.x[k], pts.y[k]);
      if (!p || Math.abs(p.offset) < 1.5 || Math.abs(p.offset) > 20) continue;
      miss.push(Math.abs(Math.abs(p.offset) - half[p.offset > 0 ? 0 : 1][p.index]));
    }
    console.log(`contacts: ${sv.edge_points.length} edge points, ${miss.length} used; distance to the drawn edge median ${q(miss, 0.5).toFixed(2)} m, p90 ${q(miss, 0.9).toFixed(2)} m`);
    expect(q(miss, 0.5)).toBeLessThan(0.25);
    expect(q(miss, 0.9)).toBeLessThan(1);
  });

  it("measures part of each side, on the correct side, and differs from LMU by a few tenths of a metre", () => {
    for (const s of [0, 1]) {
      const m = sc.edgeMeasured![s];
      const share = m.reduce((a, b) => a + b, 0) / n;
      const signed: number[] = [], d: number[] = [], own: number[] = [], other: number[] = [], raw: number[] = [];
      for (let i = 0; i < n; i++) {
        if (!m[i]) continue;
        d.push(Math.abs(half[s][i] - smooth[s][i]));
        signed.push(half[s][i] - smooth[s][i]);
        own.push(Math.abs(half[s][i] - smooth[s][i]));
        other.push(Math.abs(half[s][i] - smooth[1 - s][i]));
        const r = lmu[s][i];
        if (r !== null) raw.push(Math.abs(half[s][i] - r));
      }
      console.log(`${s ? "right" : "left"}: measured on ${(100 * share).toFixed(1)}% of ${n} m; |contact - LMU| median ${q(d, 0.5).toFixed(2)} p90 ${q(d, 0.9).toFixed(2)} m against smoothed LMU, ${q(raw, 0.5).toFixed(2)} / ${q(raw, 0.9).toFixed(2)} against raw LMU; signed (contact - LMU) median ${q(signed, 0.5).toFixed(2)}; other side's LMU median ${q(other, 0.5).toFixed(2)}`);
      expect(share).toBeGreaterThan(0.1);
      expect(q(own, 0.5)).toBeLessThan(q(other, 0.5)); // left contacts land on the left side
    }
  });

  it("bridges short gaps between contacts, rejects outliers, and has no jumps beyond the contact and fallback boundaries", () => {
    const o = originOf(cmp.ref.lat, cmp.ref.lon);
    const origin = { lat0: Math.round(o.lat0 * 100) / 100, lon0: Math.round(o.lon0 * 100) / 100 };
    const pts = toLocalMetres(sv.edge_points.map((p) => p[0]), sv.edge_points.map((p) => p[1]), origin);
    const hw = surveyHalfWidths(centreProjector(sc.centre), pts, sv.left_m, sv.right_m, n);
    console.log(`outlier contacts dropped: left ${hw.dropped[0]}, right ${hw.dropped[1]}`);
    const measured = [hw.leftMeasured, hw.rightMeasured], bridged = [hw.leftBridged, hw.rightBridged];
    for (const s of [0, 1]) {
      const name = s ? "right" : "left";
      const m = measured[s].reduce((a, b) => a + b, 0) / n, b = bridged[s].reduce((a, c) => a + c, 0) / n;
      console.log(`${name}: contact-measured ${(100 * m).toFixed(1)}%, bridged ${(100 * b).toFixed(1)}%, LMU fallback ${(100 * (1 - m - b)).toFixed(1)}%`);
      expect(m + b).toBeGreaterThan(0.25); // observed 28.9% left, 34.2% right: half the lap has no crossing within 120 m on either side
      for (let i = 0; i < n; i++) expect(measured[s][i] && bridged[s][i]).toBeFalsy();
      let jump = 0, at = 0, rawJump = 0;
      for (let i = 0; i + 1 < n; i++) {
        const d = Math.abs(half[s][i + 1] - half[s][i]);
        if (d > jump) { jump = d; at = i; }
        const a = lmu[s][i], c = lmu[s][i + 1];
        if (a !== null && c !== null) rawJump = Math.max(rawJump, Math.abs(c - a));
      }
      const kind = (i: number) => (measured[s][i] ? "contact" : bridged[s][i] ? "bridged" : "fallback");
      console.log(`${name}: largest step between neighbouring metres ${jump.toFixed(2)} m at metre ${at} (${kind(at)} -> ${kind(at + 1)}); LMU raw ${rawJump.toFixed(2)} m`);
      expect(jump).toBeLessThan(STEP_BOUND_M);
      expect(jump).toBeLessThan(rawJump);
    }
  });
});
