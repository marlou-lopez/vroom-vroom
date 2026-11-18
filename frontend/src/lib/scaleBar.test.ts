import { describe, expect, it } from "vitest";
import { scaleBar, scaleLabel } from "./scaleBar";

describe("scaleBar", () => {
  it("picks a round length that fits", () => {
    for (const ppm of [0.05, 0.4, 1, 3, 12.7]) {
      const b = scaleBar(ppm);
      expect(b.px).toBeLessThanOrEqual(120.0001);
      expect(b.px).toBeGreaterThan(40);
      expect(/^[125]0*$/.test(String(b.metres))).toBe(true);
    }
  });
  it("labels metres and kilometres", () => {
    expect(scaleLabel(50)).toBe("50 m");
    expect(scaleLabel(1000)).toBe("1 km");
    expect(scaleLabel(2000)).toBe("2 km");
  });
});
