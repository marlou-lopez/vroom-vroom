import { describe, expect, it } from "vitest";
import { NOMINAL_STEERING_RANGE_DEG, dashAt, wheelAngleDeg } from "./dashValues";

describe("wheelAngleDeg", () => {
  it("is steering x range / 2, positive to the right", () => {
    expect(wheelAngleDeg(1, 524)).toBe(262);
    expect(wheelAngleDeg(-0.5, 524)).toBe(-131);
    expect(wheelAngleDeg(0, 524)).toBe(0);
  });
  it("uses a nominal range when the car's is unknown", () => {
    expect(wheelAngleDeg(1, null)).toBe(NOMINAL_STEERING_RANGE_DEG / 2);
  });
});

describe("dashAt", () => {
  const lap = { steering: [0, 1, -1], gear: [1, 2, 3], rpm: [1000, 2000, 3000], speed_kmh: [10, 20, 30], throttle: [0, 1, 0], brake: [1, 0, 0] };
  it("interpolates the channels and rounds the gear", () => {
    const d = dashAt(lap, 0.5, 524, 12);
    expect(d).toMatchObject({ steering: 0.5, rpm: 1500, speedKmh: 15, throttle: 0.5, brake: 0.5, gear: 2, steeringRangeDeg: 524, clockS: 12 });
    expect(dashAt(lap, 0.4, null, 0).gear).toBe(1);
  });
  it("interpolates the delta to the reference, or is null without one", () => {
    expect(dashAt(lap, 0.5, null, 0, [0.2, 0.4, 0.6]).deltaS).toBeCloseTo(0.3, 9);
    expect(dashAt(lap, 0.5, null, 0).deltaS).toBeNull();
    expect(dashAt(lap, 0.5, null, 0, []).deltaS).toBeNull();
  });
  it("clamps outside the lap", () => {
    expect(dashAt(lap, -5, null, 0).rpm).toBe(1000);
    expect(dashAt(lap, 99, null, 0).rpm).toBe(3000);
    expect(dashAt({ ...lap, gear: [], rpm: [], steering: [], speed_kmh: [], throttle: [], brake: [] }, 1, null, 0).gear).toBe(0);
  });
});
