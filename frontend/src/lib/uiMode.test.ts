import { describe, expect, it } from "vitest";
import { loadUiMode, parseUiMode, saveUiMode, UI_MODE_KEY } from "./uiMode";

describe("uiMode", () => {
  it("opens the full view unless simple was saved", () => {
    expect(parseUiMode(null)).toBe("full");
    expect(parseUiMode("junk")).toBe("full");
    expect(parseUiMode("simple")).toBe("simple");
    expect(loadUiMode({ getItem: () => null })).toBe("full");
  });
  it("round-trips through storage", () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    saveUiMode("simple", st);
    expect(m.get(UI_MODE_KEY)).toBe("simple");
    expect(loadUiMode(st)).toBe("simple");
  });
  it("survives storage that throws", () => {
    const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(loadUiMode(bad)).toBe("full");
    expect(() => saveUiMode("simple", bad)).not.toThrow();
    expect(loadUiMode(null)).toBe("full");
  });
});
