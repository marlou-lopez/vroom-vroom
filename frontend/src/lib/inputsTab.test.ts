import { describe, expect, it } from "vitest";
import { loadInputsTab, parseInputsTab, saveInputsTab } from "./inputsTab";

describe("inputsTab", () => {
  it("defaults to strips for anything unknown", () => {
    expect(parseInputsTab(null)).toBe("strips");
    expect(parseInputsTab("x")).toBe("strips");
    expect(parseInputsTab("corners")).toBe("corners");
    expect(parseInputsTab("session")).toBe("session");
  });
  it("round-trips through storage and survives a throwing one", () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    saveInputsTab("corners", st);
    expect(loadInputsTab(st)).toBe("corners");
    const bad = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } };
    expect(loadInputsTab(bad)).toBe("strips");
    expect(() => saveInputsTab("corners", bad)).not.toThrow();
  });
});
