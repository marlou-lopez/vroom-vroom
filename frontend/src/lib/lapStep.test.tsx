import { describe, expect, it } from "vitest";
import type { LapWithRef } from "../api/types";
import { bestLapTime, lapGapText, lapKeyDir, stepLapId, timedLaps } from "./lapStep";

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
