import { describe, expect, it } from "vitest";
import { nearApex, signedNumber, signedSeconds } from "./cornerTable";

describe("corner table formatting", () => {
  it("never shows −0", () => {
    expect(signedNumber(-0.04, 1)).toBe("0.0");
    expect(signedNumber(-0.4, 0)).toBe("0");
    expect(signedNumber(0, 2)).toBe("0.00");
    expect(signedSeconds(-0.0004)).toBe("0.000");
  });
  it("signs real differences", () => {
    expect(signedNumber(-2, 1)).toBe("−2.0");
    expect(signedNumber(1.234, 2, " s")).toBe("+1.23 s");
    expect(signedNumber(null, 1)).toBe("–");
    expect(signedSeconds(0.12)).toBe("+0.120");
  });
  it("places a landmark against the apex, with a dash for no value", () => {
    expect(nearApex(-12.4)).toBe("12 m before apex");
    expect(nearApex(8)).toBe("8 m after apex");
    expect(nearApex(0)).toBe("at apex");
    expect(nearApex(-0.2)).toBe("at apex");
    expect(nearApex(null)).toBe("—");
  });
});
