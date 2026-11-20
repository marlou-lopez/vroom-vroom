import { describe, expect, it } from "vitest";
import type { Annotation } from "./annotations";
import type { CoachResults, CompareResponse, Corner, CornerMetrics, Finding } from "../api/types";
import { coachFixes, lapStory, relabelByStory } from "./lapStory";

const side = { brake_onset_m: 100, peak_brake: 1, min_speed_kmh: 100, min_speed_m: 120, throttle_pickup_m: 140, exit_speed_kmh: 150, coast_s: 0, overlap_s: 0, steer_corrections: 0, understeer_peak_deg_s: null, understeer_mean_deg_s: null };
const m = (id: string, d: number, lap: Partial<typeof side> = {}): CornerMetrics => ({ corner_id: id, delta_s: d, lap: { ...side, ...lap }, ref: side });
const corner = (id: string, start: number): Corner => ({ id, name: `T${id}`, start_m: start, apex_m: start + 20, end_m: start + 40, complex: null, approx: false });
const cmp = (corners: CornerMetrics[]) => ({ lap_id: "a", ref_lap_id: "b", corners }) as unknown as CompareResponse;
const cs = [1, 2, 3, 4, 5].map((i) => corner(String(i), i * 100));
const finding = (corner_id: string, fix: string, kind: Finding["kind"] = "issue"): Finding =>
  ({ id: `f${corner_id}`, corner_id, corner: `T${corner_id}`, kind, time_s: 0.1, what: "", fix, cue_type: "feel", evidence: [], reviewed: false }) as unknown as Finding;
const results = (fs: Finding[]) => ({ analyze: { findings: fs } }) as unknown as CoachResults;

// Four losses of the same cause (late braking) so the computed tips are alike.
const metrics = [m("1", 0.3, { brake_onset_m: 130 }), m("2", 0.25, { brake_onset_m: 130 }), m("3", 0.2, { brake_onset_m: 130 }), m("4", 0.1, { brake_onset_m: 130 }), m("5", -0.2)];

describe("lapStory", () => {
  it("takes the three biggest losses, worst first, and every corner in track order", () => {
    const s = lapStory(cmp(metrics), cs, {}, "your best lap");
    expect(s.cards.map((c) => c.row.corner.id)).toEqual(["1", "2", "3"]);
    expect(s.cards.map((c) => c.rank)).toEqual([1, 2, 3]);
    expect(s.rows).toHaveLength(5);
    expect(s.losses.map((r) => r.corner.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("never shows the same advice text on two cards, computed or from the coach", () => {
    for (const r of [{}, results([finding("1", "Brake later."), finding("2", "Brake later."), finding("3", "brake  later.")])]) {
      const s = lapStory(cmp(metrics), cs, r, "your best lap");
      const texts = s.cards.map((c) => c.advice?.text).filter(Boolean);
      expect(new Set(texts.map((t) => t!.toLowerCase().replace(/\s+/g, " "))).size).toBe(texts.length);
    }
  });

  it("uses the coach's fix once, and falls back to the computed tip for a repeat", () => {
    const s = lapStory(cmp(metrics), cs, results([finding("1", "Brake later."), finding("2", "Brake later.")]), "your best lap");
    expect(s.cards[0].advice).toEqual({ by: "coach", text: "Brake later." });
    expect(s.cards[1].advice?.by).toBe("computed");
    // Card 3 would repeat card 2's computed tip, so it shows no advice rather than the same text.
    expect(s.cards[2].advice).toBeNull();
  });

  it("ignores a strength as a fix and is empty for the lap's own reference", () => {
    expect(coachFixes(results([finding("1", "Keep it.", "strength")])).size).toBe(0);
    expect(lapStory({ ...cmp(metrics), ref_lap_id: "a" } as CompareResponse, cs, {}, "x").rows).toEqual([]);
  });
});

describe("relabelByStory", () => {
  const ann = (cornerId: string, label: string, kind: Annotation["kind"] = "issue", reviewed = false) => ({ cornerId, label, kind, reviewed }) as unknown as Annotation;
  it("numbers unreviewed issues by the story's ranking and leaves other marks alone", () => {
    const { losses } = lapStory(cmp(metrics), cs, {}, "x");
    const out = relabelByStory([ann("2", "1"), ann("1", "2"), ann("3", "!", "minor"), ann("4", "3", "issue", true)], losses);
    expect(out.map((a) => a.label)).toEqual(["2", "1", "!", "3"]);
  });
  it("numbers issues outside the ranking after it, so no number repeats", () => {
    const { losses } = lapStory(cmp(metrics), cs, {}, "x");
    const out = relabelByStory([ann("1", "2"), ann("5", "1"), ann("9", "3")], losses);
    expect(out.map((a) => a.label)).toEqual(["1", "5", "6"]);
  });
});
