import { describe, expect, it } from "vitest";
import { DEFAULT_STRIPS, loadStrips, moveStrip, parseStrips, saveStrips, toggleStrip } from "./stripChoice";

describe("stored strip choice", () => {
  it("round-trips a valid choice", () => {
    const mem = new Map<string, string>();
    const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    saveStrips(["rpm", "speed"], st);
    expect(loadStrips(st)).toEqual(["rpm", "speed"]);
  });
  it("falls back to the default for unknown channels, junk, empty, duplicates and missing", () => {
    for (const raw of ['["speed","nope"]', "not json", "[]", '["speed","speed"]', '"speed"', null]) {
      expect(parseStrips(raw)).toEqual([...DEFAULT_STRIPS]);
    }
  });
  it("survives a storage that throws", () => {
    const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(loadStrips(bad)).toEqual([...DEFAULT_STRIPS]);
    expect(() => saveStrips(["speed"], bad)).not.toThrow();
  });
  it("adds, removes (never the last) and moves", () => {
    expect(toggleStrip(["speed"], "rpm")).toEqual(["speed", "rpm"]);
    expect(toggleStrip(["speed", "rpm"], "speed")).toEqual(["rpm"]);
    expect(toggleStrip(["speed"], "speed")).toEqual(["speed"]);
    expect(moveStrip(["speed", "rpm", "gear"], "rpm", -1)).toEqual(["rpm", "speed", "gear"]);
    expect(moveStrip(["speed", "rpm"], "speed", -1)).toEqual(["speed", "rpm"]);
    expect(moveStrip(["speed", "rpm"], "rpm", 1)).toEqual(["speed", "rpm"]);
  });
});
