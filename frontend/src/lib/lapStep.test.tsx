import { describe, expect, it } from "vitest";
import type { LapWithRef } from "../api/types";
import { bestLapTime, cycleRefId, lapGapText, lapKeyDir, refChoices, refKeyDir, stepLapId, timedLaps } from "./lapStep";

const lap = (id: string, no: number, t: number | null, kind = "flying", valid = true) =>
  ({ lap_id: id, lap_no: no, lap_time_s: t, kind, valid, user_valid: null }) as unknown as LapWithRef;
const laps = [lap("a", 1, null, "out"), lap("b", 2, 100), lap("c", 3, 99.5), lap("d", 4, 98, "flying", false), lap("e", 5, 101)];
const key = (k: string, extra = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });

describe("lap stepping", () => {
  it("lists timed flying laps and the current lap", () => {
    expect(timedLaps(laps, "b").map((l) => l.lap_id)).toEqual(["b", "c", "d", "e"]);
    expect(timedLaps(laps, "a").map((l) => l.lap_id)).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("finds the best valid lap and each lap's gap", () => {
    const best = bestLapTime(laps);
    expect(best).toBe(99.5);
    expect(lapGapText(laps[2], best)).toBe("best");
    expect(lapGapText(laps[1], best)).toBe("+0.500");
    expect(lapGapText(laps[3], best)).toBe("");
    expect(lapGapText(laps[0], best)).toBe("");
  });
  it("steps within the list and stops at the ends", () => {
    const timed = timedLaps(laps, "b");
    expect(stepLapId(timed, "c", 1)).toBe("d");
    expect(stepLapId(timed, "c", -1)).toBe("b");
    expect(stepLapId(timed, "b", -1)).toBeNull();
    expect(stepLapId(timed, "e", 1)).toBeNull();
    expect(stepLapId(timed, "zz", 1)).toBeNull();
  });
  it("maps ↑/↓ and leaves fields, sliders and modified keys alone", () => {
    expect(lapKeyDir(key("ArrowUp"), null)).toBe(-1);
    expect(lapKeyDir(key("ArrowDown"), null)).toBe(1);
    expect(lapKeyDir(key("ArrowLeft"), null)).toBeNull();
    expect(lapKeyDir(key("ArrowDown", { shiftKey: true }), null)).toBeNull();
    const sel = document.createElement("select");
    expect(lapKeyDir(key("ArrowDown"), sel)).toBeNull();
    const slider = document.createElement("div");
    slider.setAttribute("role", "slider");
    expect(lapKeyDir(key("ArrowDown"), slider)).toBeNull();
  });
});

describe("reference lap choice (vroom-r1t)", () => {
  const mk = (id: string, t: number | null = 90) => ({ lap_id: id, kind: "flying", lap_time_s: t }) as never;
  const rl = [mk("a"), mk("b"), mk("c"), mk("o", null)];
  it("lists timed flying laps except the current one", () => {
    expect(refChoices(rl, "b").map((l) => l.lap_id)).toEqual(["a", "c"]);
  });
  it("cycles with wrap, and starts at an end from an outside reference", () => {
    const ch = refChoices(rl, "b");
    expect(cycleRefId(ch, "a", 1)).toBe("c");
    expect(cycleRefId(ch, "c", 1)).toBe("a");
    expect(cycleRefId(ch, "a", -1)).toBe("c");
    expect(cycleRefId(ch, "ideal:x", 1)).toBe("a");
    expect(cycleRefId(ch, "ideal:x", -1)).toBe("c");
    expect(cycleRefId([], "a", 1)).toBeNull();
  });
  it("reads R and Shift+R, not in fields or with modifiers", () => {
    const k = (key: string, o = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
    expect(refKeyDir(k("r"), null)).toBe(1);
    expect(refKeyDir(k("R", { shiftKey: true }), null)).toBe(-1);
    expect(refKeyDir(k("r", { ctrlKey: true }), null)).toBeNull();
    expect(refKeyDir(k("x"), null)).toBeNull();
    expect(refKeyDir(k("r"), document.createElement("input"))).toBeNull();
  });
});
