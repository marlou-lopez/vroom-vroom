import { describe, expect, it } from "vitest";
import { latLonToWorld } from "./elevation";
import { worldToLatLon } from "./elevation";
import type { XY } from "./geo";
import {
  CONTACT_BRIDGE_M, CONTACT_SMOOTH_HALF_M, centreProjector, kerbWidth, mapSurvey, smoothLmu, surveyHalfWidths, type SurveyFile,
} from "./trackSurvey";

const M_PER_DEG = (6371008.8 * Math.PI) / 180;
/** Lat/lon of a straight lap along world +x at z = 0, one point per metre. */
function line(n: number) {
  const lat = new Array<number>(n).fill(60);
  const lon = Array.from({ length: n }, (_, i) => i / (M_PER_DEG * Math.cos((60 * Math.PI) / 180)));
  return { lat, lon };
}
const empty = { edges: [], kerbs: [] } as Pick<SurveyFile, "edges" | "kerbs">;

describe("latLon helper used by the tests", () => {
  it("the line runs along world x", () => {
    const { lat, lon } = line(11);
    expect(latLonToWorld(lat[10], lon[10]).x).toBeCloseTo(10, 6);
  });
});

describe("mapSurvey edges", () => {
  const { lat, lon } = line(100);

  it("takes the median half-width per index and side from the nearest grid point; null where nothing", () => {
    const s = mapSurvey({
      ...empty,
      edges: [[10.2, 3, 0, 5], [9.8, -2, 0, 7], [10.1, 0, 0, 9], [10, 1, 1, 6], [40, 0, 1, 4]],
    }, lat, lon);
    expect(s.left_m).toHaveLength(100);
    expect(s.left_m[10]).toBe(7);
    expect(s.right_m[10]).toBe(6);
    expect(s.right_m[40]).toBe(4);
    expect(s.left_m[11]).toBeNull();
  });

  it("drops samples farther than 15 m from the lap, also across cell borders", () => {
    const s = mapSurvey({ ...empty, edges: [[50, 14.5, 0, 5], [51, 15.5, 0, 5], [60, 40, 1, 5]] }, lat, lon);
    expect(s.left_m[50]).toBe(5);
    expect(s.left_m[51]).toBeNull();
    expect(s.right_m.every((v) => v === null)).toBe(true);
  });

  it("samples beyond the lap's ends snap to the end points", () => {
    const s = mapSurvey({ ...empty, edges: [[-3, 0, 0, 5], [102, 0, 1, 6]] }, lat, lon);
    expect(s.left_m[0]).toBe(5);
    expect(s.right_m[99]).toBe(6);
  });
});

describe("mapSurvey bank", () => {
  const { lat, lon } = line(100);

  it("takes the median bank per index (degrees, right side lower positive) and null where nothing", () => {
    const s = mapSurvey({ ...empty, bank: [[10.2, 3, 2], [9.8, -2, 4], [10.1, 0, 6], [60, 1, -1.5]] }, lat, lon);
    expect(s.bank_deg).toHaveLength(100);
    expect(s.bank_deg[10]).toBe(4);
    expect(s.bank_deg[60]).toBe(-1.5);
    expect(s.bank_deg[30]).toBeNull();
  });

  it("interpolates gaps of up to 8 m and leaves longer ones, and drops samples off the road", () => {
    const s = mapSurvey({ ...empty, bank: [[10, 0, 1], [14, 0, 3], [30, 0, 1], [45, 0, 1], [20, 40, 9]] }, lat, lon);
    expect(s.bank_deg[12]).toBeCloseTo(2);
    expect(s.bank_deg[20]).toBeNull();
    expect(s.bank_deg.filter((v) => v === 9)).toHaveLength(0);
  });

  it("is all null without bank samples", () => {
    expect(mapSurvey(empty, lat, lon).bank_deg.every((v) => v === null)).toBe(true);
  });
});

describe("mapSurvey kerbs", () => {
  const { lat, lon } = line(200);
  const hits = (from: number, to: number, side: 0 | 1, kind: "flat" | "razor" | "other"): [number, number, 0 | 1, typeof kind][] =>
    Array.from({ length: to - from + 1 }, (_, i) => [from + i, 1, side, kind]);

  it("merges hits into runs per side, drops short ones, takes the most common kind", () => {
    const s = mapSurvey({
      ...empty,
      kerbs: [
        ...hits(20, 30, 0, "flat"), ...hits(34, 40, 0, "razor"), ...hits(36, 40, 0, "razor"), // gap of 3 from the flat hits: one run; per metre 11 flat, 7 razor
        ...hits(100, 101, 1, "flat"), // 2 m: dropped
        ...hits(120, 130, 1, "other"),
        ...hits(150, 160, 0, "flat"), // 9 m gap from 40: separate
      ],
    }, lat, lon);
    expect(s.kerbs).toEqual([
      { side: "left", start_m: 20, end_m: 40, kind: "flat", width_m: null },
      { side: "right", start_m: 120, end_m: 130, kind: "other", width_m: null },
      { side: "left", start_m: 150, end_m: 160, kind: "flat", width_m: null },
    ]);
  });

  it("runs on opposite sides do not merge, and runs do not wrap across the start/finish line", () => {
    const s = mapSurvey({ ...empty, kerbs: [...hits(0, 5, 0, "flat"), ...hits(194, 199, 0, "flat"), ...hits(2, 8, 1, "razor")] }, lat, lon);
    expect(s.kerbs.map((k) => [k.side, k.start_m, k.end_m])).toEqual([["left", 0, 5], ["right", 2, 8], ["left", 194, 199]]);
  });
});

describe("mapSurvey contacts", () => {
  const { lat, lon } = line(100);

  it("turns contacts near the lap into [lat, lon] points per kind and drops those far away", () => {
    const s = mapSurvey({ ...empty, contacts: [[10, 4, "edge"], [20, -5, "edge"], [30, 6, "kerb_outer"], [50, 40, "edge"]] }, lat, lon);
    expect(s.edge_points).toHaveLength(2);
    expect(s.kerb_outer_points).toHaveLength(1);
    const w = latLonToWorld(s.edge_points[0][0], s.edge_points[0][1]);
    expect(w.x).toBeCloseTo(10, 1);
    expect(w.z).toBeCloseTo(4, 1);
  });

  it("works for a survey without contacts", () => {
    const s = mapSurvey(empty, lat, lon);
    expect(s.edge_points).toEqual([]);
    expect(s.kerb_outer_points).toEqual([]);
  });
});

// A straight centreline along +x (local metres, y north): left of travel is +y.
const xyOf = (pts: [number, number][]): XY => ({ x: Float64Array.from(pts.map((p) => p[0])), y: Float64Array.from(pts.map((p) => p[1])) });
const straight = (n: number) => xyOf(Array.from({ length: n }, (_, i) => [i, 0] as [number, number]));

describe("centreProjector", () => {
  const project = centreProjector(straight(200));

  it("gives the nearest index and a signed offset, + to the left of travel", () => {
    expect(project(50.2, 4)).toEqual({ index: 50, offset: 4 });
    expect(project(80, -3.5)).toEqual({ index: 80, offset: -3.5 });
  });

  it("is null beyond 20 m", () => {
    expect(project(50, 21)).toBeNull();
    expect(project(50, 19)).not.toBeNull();
  });

  it("follows a curve: the offset is measured along the segment normal", () => {
    // Counter-clockwise circle of radius 100: left is inward.
    const pts = Array.from({ length: 628 }, (_, i) => [100 * Math.cos(i / 100), 100 * Math.sin(i / 100)] as [number, number]);
    const p = centreProjector(xyOf(pts))(95 * Math.cos(2), 95 * Math.sin(2))!;
    expect(p.offset).toBeCloseTo(5, 1);
    expect(p.index).toBe(200);
  });
});

describe("surveyHalfWidths", () => {
  const n = 400;
  const project = centreProjector(straight(n));
  const none = Array.from({ length: n }, () => null);
  const flat = (v: number) => new Array<number>(n).fill(v);
  const pts = (list: [number, number][]) => xyOf(list);

  it("uses the contacts where they are: side from the sign, half-width from the offset", () => {
    const e = surveyHalfWidths(project, pts([[100, 5.5], [100.4, 5.5], [200, -4]]), flat(8), flat(8), n);
    expect(e.left[100]).toBeCloseTo(5.5, 6);
    expect(e.leftMeasured[100]).toBe(1);
    expect(e.leftMeasured[102]).toBe(0);
    expect(e.right[200]).toBeCloseTo(4, 6);
    expect(e.rightMeasured[200]).toBe(1);
    expect(e.rightMeasured[100]).toBe(0);
  });

  it("pools one metre either side, takes the median of the contacts of an index and smooths lightly", () => {
    const e = surveyHalfWidths(project, pts([[100, 5], [100.1, 5], [100.2, 9], [101, 5]]), none, none, n);
    expect(e.leftMeasured.slice(98, 104)).toEqual(Uint8Array.from([0, 1, 1, 1, 1, 0]));
    expect(e.left[100]).toBeCloseTo(5, 6); // the 9 m outlier is outvoted
    // light smoothing: a step in the contacts is spread over at most CONTACT_SMOOTH_HALF_M metres
    const step = surveyHalfWidths(project, pts(Array.from({ length: 40 }, (_, i) => [100 + i, i < 20 ? 5 : 6] as [number, number])), none, none, n);
    expect(step.left[100]).toBeCloseTo(5, 0);
    expect(step.left[100 + 20 - CONTACT_SMOOTH_HALF_M - 2]).toBeCloseTo(5, 6);
    expect(step.left[100 + 20 + CONTACT_SMOOTH_HALF_M + 2]).toBeCloseTo(6, 6);
  });

  it("without contacts on a side, smooths LMU over 15 m (and fills what LMU lacks)", () => {
    const lmu = Array.from({ length: n }, (_, i) => (i % 2 ? 6 : 8)); // 2 m zigzag around 7
    const e = surveyHalfWidths(project, pts([[100, -5]]), lmu, lmu, n);
    expect(e.left[200]).toBeCloseTo(7, 0);
    expect(Math.abs(e.left[201] - e.left[200])).toBeLessThan(0.2);
    expect(e.leftMeasured.every((v) => v === 0)).toBe(true);
    expect(surveyHalfWidths(project, pts([]), none, none, n).left[10]).toBe(7); // nothing at all: fallback
    expect(smoothLmu(none, 10, 6)[3]).toBe(6);
  });

  it("shifts the LMU fallback by the correction at each end of a gap, interpolated across it", () => {
    // LMU says 8 everywhere; contacts at 100..110 say 7 and at 200..210 say 5: the gap runs from 7 to 5 (LMU 8 plus -1 to -3).
    const left: [number, number][] = [];
    for (let i = 100; i <= 110; i++) left.push([i, 7]);
    for (let i = 200; i <= 210; i++) left.push([i, 5]);
    const e = surveyHalfWidths(project, pts(left), flat(8), flat(8), n);
    expect(e.left[105]).toBeCloseTo(7, 6);
    expect(e.left[111]).toBeCloseTo(7, 0);
    expect(e.left[155]).toBeCloseTo(6, 0);
    expect(e.left[199]).toBeCloseTo(5, 0);
    for (let i = 111; i < 199; i++) expect(Math.abs(e.left[i + 1] - e.left[i])).toBeLessThan(0.05);
    expect(e.leftMeasured[155]).toBe(0);
    // beyond the contacts the loop wraps: the gap from 210 round to 100 goes from 5 back to 7
    expect(e.left[300]).toBeGreaterThan(5);
    expect(e.left[300]).toBeLessThan(7);
  });

  it("bridges gaps of at most CONTACT_BRIDGE_M between contacts with a straight line, ignoring LMU, and leaves longer gaps to LMU", () => {
    const left: [number, number][] = [];
    for (let i = 100; i <= 102; i++) left.push([i, 5]);
    for (let i = 100 + 2 + CONTACT_BRIDGE_M; i <= 104 + CONTACT_BRIDGE_M; i++) left.push([i, 7]); // gap of exactly CONTACT_BRIDGE_M
    for (let i = 300; i <= 302; i++) left.push([i, 6]); // a longer gap before it
    const e = surveyHalfWidths(project, pts(left), flat(12), flat(12), n);
    const mid = 101 + CONTACT_BRIDGE_M / 2;
    expect(e.leftBridged[mid]).toBe(1);
    expect(e.leftMeasured[mid]).toBe(0);
    expect(e.left[mid]).toBeGreaterThan(5.5);
    expect(e.left[mid]).toBeLessThan(6.5); // not LMU's 12
    expect(e.leftBridged[100]).toBe(0);
    expect(e.leftBridged[200]).toBe(0); // 130 -> 300 is too long
  });

  it("drops a contact that is more than CONTACT_OUTLIER_M from the median of the contacts within 10 m, and reports it", () => {
    const left: [number, number][] = [];
    for (let i = 100; i <= 120; i++) left.push([i, 5]);
    left.push([110.2, 7]); // outlier
    const e = surveyHalfWidths(project, pts(left), none, none, n);
    expect(e.dropped).toEqual([1, 0]);
    expect(e.left[110]).toBeCloseTo(5, 6);
    // a lone pair is not judged
    expect(surveyHalfWidths(project, pts([[50, 5], [50, 9]]), none, none, n).dropped).toEqual([0, 0]);
  });

  it("ignores contacts that are not on this road (pit lane, other section)", () => {
    const e = surveyHalfWidths(project, pts([[100, 0.5], [100, 25], [100, 18.5]]), none, none, n);
    expect(e.leftMeasured[100]).toBe(1);
    expect(e.left[100]).toBeCloseTo(18.5, 6);
    expect(e.leftMeasured.reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe("kerbWidth", () => {
  const project = centreProjector(straight(200));
  const half = new Array<number>(200).fill(6);
  const outer = (offsets: number[]) => xyOf(offsets.map((o, i) => [50 + i, o] as [number, number]));

  it("is the median of the outer points' distance beyond the edge, within the run and on its side", () => {
    expect(kerbWidth(project, outer([7, 7.1, 6.9, 7.2, 7.0]), "left", 40, 100, half)).toBeCloseTo(1, 6);
    expect(kerbWidth(project, outer([-7, -7.1, -6.9]), "right", 40, 100, half)).toBeCloseTo(1, 6);
    expect(kerbWidth(project, outer([-7, -7.1, -6.9]), "left", 40, 100, half)).toBeNull(); // wrong side
    expect(kerbWidth(project, outer([7, 7.1, 6.9]), "left", 80, 100, half)).toBeNull(); // outside the run
  });

  it("needs three points and a width between 0.3 and 3 m", () => {
    expect(kerbWidth(project, outer([7, 7.1]), "left", 0, 199, half)).toBeNull();
    expect(kerbWidth(project, outer([6.1, 6.1, 6.1]), "left", 0, 199, half)).toBeNull();
    expect(kerbWidth(project, outer([10, 10, 10]), "left", 0, 199, half)).toBeNull();
  });
});

describe("worldToLatLon in the survey", () => {
  it("round-trips contact points", () => {
    const { lat, lon } = worldToLatLon(100, 50);
    const w = latLonToWorld(lat, lon);
    expect(w.x).toBeCloseTo(100, 6);
  });
});
