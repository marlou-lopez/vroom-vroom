import { describe, expect, it } from "vitest";
import { cleanGear, gearShifts, shiftLabel } from "./gearShifts";

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
