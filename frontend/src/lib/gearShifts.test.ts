import { describe, expect, it } from "vitest";
import { cleanGear, gearShifts, shiftLabel, thinShiftLabels } from "./gearShifts";

describe("gearShifts", () => {
  it("reports each change with its index and gears", () => {
    expect(gearShifts([2, 2, 3, 3, 3, 2, 2])).toEqual([{ i: 2, from: 2, to: 3 }, { i: 5, from: 3, to: 2 }]);
  });

  it("reports nothing for a single-sample blip", () => {
    expect(gearShifts([3, 3, 0, 3, 3])).toEqual([]);
    expect(gearShifts([3, 3, 4, 3, 3])).toEqual([]);
    expect(cleanGear([3, 3, 0, 3, 3])).toEqual([3, 3, 3, 3, 3]);
  });

  it("keeps a real shift next to a blip", () => {
    expect(gearShifts([3, 0, 3, 4, 4])).toEqual([{ i: 3, from: 3, to: 4 }]);
  });

  it("handles empty and short channels", () => {
    expect(gearShifts([])).toEqual([]);
    expect(gearShifts([4])).toEqual([]);
  });

  it("labels shifts", () => {
    expect(shiftLabel({ i: 1, from: 3, to: 4 })).toBe("3→4");
    expect(shiftLabel({ i: 1, from: 1, to: 0 })).toBe("1→N");
  });
});

describe("thinShiftLabels", () => {
  it("keeps spaced labels", () => {
    expect(thinShiftLabels([0, 50, 100], [30, 30, 30], 3)).toEqual([true, true, true]);
  });

  it("drops labels that would overprint the last kept one", () => {
    expect(thinShiftLabels([0, 10, 20, 40], [30, 30, 30, 30], 3)).toEqual([true, false, false, true]);
  });

  it("handles none", () => {
    expect(thinShiftLabels([], [], 3)).toEqual([]);
  });
});
