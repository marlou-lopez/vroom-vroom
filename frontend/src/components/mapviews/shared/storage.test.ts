import { describe, expect, it } from "vitest";
import { loadFlag, loadSetting, loadString, saveFlag, saveSetting, saveString } from "./storage";

const reading = (v: string | null) => ({ getItem: () => v });
const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); } };
const ALLOWED = ["a", "b"] as const;

describe("loadSetting", () => {
  it("returns an allowed stored value", () => {
    expect(loadSetting("k", ALLOWED, "a", { storage: reading("b") })).toBe("b");
  });

  it("falls back for null storage, a missing key, a stale value or a throwing storage", () => {
    expect(loadSetting("k", ALLOWED, "a", { storage: null })).toBe("a");
    expect(loadSetting("k", ALLOWED, "a", { storage: reading(null) })).toBe("a");
    expect(loadSetting("k", ALLOWED, "a", { storage: reading("zzz") })).toBe("a");
    expect(loadSetting("k", ALLOWED, "b", { storage: throwing })).toBe("b");
  });

  it("maps legacy values, and does not treat Object.prototype names as legacy", () => {
    const legacy = { "0": "b" } as const;
    expect(loadSetting("k", ALLOWED, "a", { legacy, storage: reading("0") })).toBe("b");
    expect(loadSetting("k", ALLOWED, "a", { legacy, storage: reading("toString") })).toBe("a");
  });
});

describe("saveSetting / saveString", () => {
  it("writes the key", () => {
    const calls: [string, string][] = [];
    saveSetting("k", "b", { setItem: (k, v) => void calls.push([k, v]) });
    saveString("j", "x", { setItem: (k, v) => void calls.push([k, v]) });
    expect(calls).toEqual([["k", "b"], ["j", "x"]]);
  });

  it("does not throw when setItem throws or storage is null", () => {
    expect(() => saveSetting("k", "a", throwing)).not.toThrow();
    expect(() => saveSetting("k", "a", null)).not.toThrow();
  });
});

describe("loadString", () => {
  it("gives null when missing or unreadable", () => {
    expect(loadString("k", reading(null))).toBeNull();
    expect(loadString("k", throwing)).toBeNull();
    expect(loadString("k", null)).toBeNull();
    expect(loadString("k", reading("v"))).toBe("v");
  });
});

describe("flags", () => {
  it("default on; only a stored 0 is off", () => {
    expect(loadFlag("k", reading(null))).toBe(true);
    expect(loadFlag("k", reading("1"))).toBe(true);
    expect(loadFlag("k", reading("0"))).toBe(false);
    expect(loadFlag("k", throwing)).toBe(true);
  });

  it("saves 1 or 0", () => {
    const calls: string[] = [];
    saveFlag("k", true, { setItem: (_k, v) => void calls.push(v) });
    saveFlag("k", false, { setItem: (_k, v) => void calls.push(v) });
    expect(calls).toEqual(["1", "0"]);
  });
});
