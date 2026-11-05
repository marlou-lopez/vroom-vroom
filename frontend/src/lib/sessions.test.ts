import { describe, expect, it } from "vitest";
import type { SessionMeta } from "../api/types";
import { comboKey, focusOutcome, groupCombos, trendPaths } from "./sessions";

const s = (id: string, track: string, car: string, started: string): SessionMeta => ({
  session_id: id, track_name: `Track ${track}`, track_layout: "GP", track_id: track, track_length_m: 1000,
  car_name: `Car ${car}`, car_id: car, car_class: "GT3", session_type: "Practice", game_build: "1", started_at: started,
  driver: "me", steering_range_deg: 540, car_dims: null,
});

describe("groupCombos", () => {
  const sessions = [
    s("1", "spa", "a", "2026-10-01T10:00:00"),
    s("2", "monza", "a", "2026-10-05T10:00:00"),
    s("3", "spa", "a", "2026-10-09T10:00:00"),
    s("4", "spa", "b", "2026-10-03T10:00:00"),
  ];
  it("groups by track and car, counting sessions", () => {
    const g = groupCombos(sessions);
    expect(g).toHaveLength(3);
    expect(g.find((c) => c.key === comboKey(sessions[0]))).toMatchObject({ count: 2, label: "Track spa · Car a" });
  });
  it("orders groups by their newest session, newest first, whatever the input order", () => {
    expect(groupCombos(sessions).map((c) => c.key)).toEqual(["spa|a", "monza|a", "spa|b"]);
    expect(groupCombos([...sessions].reverse()).map((c) => c.key)).toEqual(["spa|a", "monza|a", "spa|b"]);
  });
  it("is empty for no sessions", () => {
    expect(groupCombos([])).toEqual([]);
  });
});

describe("focusOutcome", () => {
  it("maps improved true/false/null", () => {
    expect(focusOutcome(true)).toMatchObject({ glyph: "▲", tone: "good" });
    expect(focusOutcome(false)).toMatchObject({ glyph: "▼", tone: "bad" });
    expect(focusOutcome(null)).toMatchObject({ glyph: "●", tone: "unclear" });
  });
});

describe("trendPaths", () => {
  it("spaces points evenly and puts faster laps higher", () => {
    const t = trendPaths([{ best: 144, theo: 142 }, { best: 143, theo: 141.5 }, { best: 142.5, theo: 141 }], 1000, 200);
    expect(t.best.startsWith("M0 ")).toBe(true);
    expect(t.best).toContain("L1000 ");
    const ys = t.best.match(/-?\d+(\.\d+)? (-?\d+(\.\d+)?)/g)!.map((p) => Number(p.split(" ")[1]));
    expect(ys[0]).toBeGreaterThan(ys[2]);
    expect(t.lo).toBeCloseTo(141);
    expect(t.hi).toBeCloseTo(144);
  });
  it("skips sessions without a time and copes with one point", () => {
    expect(trendPaths([{ best: null, theo: null }], 1000, 200).best).toBe("");
    expect(trendPaths([{ best: 143, theo: null }], 1000, 200).best).toContain("M");
  });
});
