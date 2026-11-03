import { describe, expect, it } from "vitest";
import type { CoachResult, CoachResults, CompareResponse, Finding, FindingKind, TrackMap } from "../api/types";
import { annotationColors } from "../theme";
import { stackIndices, toAnnotations } from "./annotations";

const cmp = {
  distance: Array.from({ length: 1001 }, (_, i) => i),
  lap: { t: Array.from({ length: 1001 }, (_, i) => i * 0.1) },
} as unknown as CompareResponse;

const corner = (id: string, start: number, apex: number, end: number) => ({
  id, name: id.toUpperCase(), start_m: start, apex_m: apex, end_m: end, complex: null, approx: false,
});
const map: TrackMap = {
  track_id: "t", length_m: 1000, landmarks: [],
  corners: [corner("a", 100, 150, 200), corner("b", 300, 350, 400), corner("c", 500, 550, 600), corner("d", 700, 750, 800), corner("e", 850, 880, 950)],
};

const finding = (id: string, cornerId: string, kind: FindingKind, time_s: number, reviewed = false): Finding => ({
  id, corner_id: cornerId, corner: cornerId.toUpperCase(), kind, time_s, what: "w", fix: "f", cue_type: "feel", evidence: [], reviewed,
});
const result = (command: CoachResult["command"], findings: Finding[]): CoachResult => ({
  id: command, command, lap_id: "l", ref_lap_id: "r", summary: "", findings, focus: null, encouragement: null,
  stats: {}, warnings: [], cost_usd: null, created_at: "",
});

describe("toAnnotations", () => {
  const results: CoachResults = {
    analyze: result("analyze", [
      finding("f1", "a", "issue", 0.12),
      finding("f2", "b", "issue", 0.35),
      finding("f3", "c", "issue", 0.2),
      finding("f4", "d", "minor", 0.03),
      finding("f5", "e", "strength", -0.05),
    ]),
    average: result("average", [finding("f6", "a", "inconsistent", 0.08)]),
  };
  const anns = toAnnotations(results, cmp, map);
  const byId = (id: string) => anns.find((a) => a.findingId === id)!;

  it("numbers issues by descending time_s and labels the other kinds", () => {
    expect(byId("f2").label).toBe("1");
    expect(byId("f3").label).toBe("2");
    expect(byId("f1").label).toBe("3");
    expect(byId("f4").label).toBe("!");
    expect(byId("f5").label).toBe("✓");
    expect(byId("f6").label).toBe("~");
  });
  it("uses the spec colours", () => {
    expect(byId("f2").color).toBe(annotationColors.issue);
    expect(byId("f4").color).toBe(annotationColors.minor);
    expect(byId("f5").color).toBe(annotationColors.strength);
    expect(byId("f6").color).toBe(annotationColors.inconsistent);
  });
  it("combines analyze and average into one set", () => {
    expect(anns).toHaveLength(6);
  });
  it("fills distances and the lap's own times", () => {
    const a = byId("f1");
    expect([a.startM, a.apexM, a.endM]).toEqual([100, 150, 200]);
    expect(a.tStart).toBeCloseTo(10);
    expect(a.tApex).toBeCloseTo(15);
    expect(a.tEnd).toBeCloseTo(20);
    expect(a.cornerId).toBe("a");
    expect(a.finding.id).toBe("f1");
  });
  it("reviewed findings are muted with a tick", () => {
    const r = toAnnotations({ analyze: result("analyze", [finding("x", "a", "issue", 0.2, true)]) }, cmp, map);
    expect(r[0].label).toBe("✓");
    expect(r[0].color).toBe(annotationColors.reviewed);
    expect(r[0].reviewed).toBe(true);
  });
  it("skips findings for corners missing from the map and handles empty results", () => {
    expect(toAnnotations({ analyze: result("analyze", [finding("z", "nope", "issue", 1)]) }, cmp, map)).toEqual([]);
    expect(toAnnotations({}, cmp, map)).toEqual([]);
  });
});

describe("stackIndices", () => {
  it("counts earlier items with the same key", () => {
    expect(stackIndices(["a", "b", "a", "a", "b"])).toEqual([0, 0, 1, 2, 1]);
    expect(stackIndices([])).toEqual([]);
  });
});

describe("Annotation.stack", () => {
  it("is 0 for a lone finding and increments for later findings on the same corner", () => {
    const anns = toAnnotations(
      { analyze: result("analyze", [finding("f1", "a", "issue", 0.2), finding("f2", "b", "minor", 0.1)]), average: result("average", [finding("f3", "a", "inconsistent", 0.05)]) },
      cmp, map,
    );
    expect(anns.map((a) => [a.findingId, a.stack])).toEqual([["f1", 0], ["f2", 0], ["f3", 1]]);
  });
});
