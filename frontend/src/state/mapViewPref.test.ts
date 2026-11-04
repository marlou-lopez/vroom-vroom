import { describe, expect, it } from "vitest";
import { loadTrackView, saveTrackView } from "./mapViewPref";

const KEY = "vroom.trackView";
const reading = (v: string | null) => ({ getItem: (k: string) => (k === KEY ? v : null) });

describe("loadTrackView", () => {
  it.each(["2d", "2d-detailed", "3d"] as const)("returns the stored id %s", (id) => {
    expect(loadTrackView(reading(id))).toBe(id);
  });

  it("falls back to 2d for null storage, a missing key, a bogus id or a throwing storage", () => {
    expect(loadTrackView(null)).toBe("2d");
    expect(loadTrackView(reading(null))).toBe("2d");
    expect(loadTrackView(reading("bogus"))).toBe("2d");
    expect(loadTrackView({ getItem: () => { throw new Error("denied"); } })).toBe("2d");
  });
});

describe("saveTrackView", () => {
  it("writes the key", () => {
    const calls: [string, string][] = [];
    saveTrackView("3d", { setItem: (k, v) => void calls.push([k, v]) });
    expect(calls).toEqual([[KEY, "3d"]]);
  });

  it("does not throw when setItem throws or storage is null", () => {
    expect(() => saveTrackView("2d", { setItem: () => { throw new Error("full"); } })).not.toThrow();
    expect(() => saveTrackView("2d", null)).not.toThrow();
  });
});
