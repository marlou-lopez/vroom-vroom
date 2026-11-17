import { describe, expect, it } from "vitest";
import { LOCKUP_SLIP, MIN_SLIP_SPEED_MS, WHEELSPIN_SLIP, aidRuns, mapSpan, runsOf, slipRatio, type AidChannels } from "./driverAids";

const filled = (n: number, v: number) => new Array<number>(n).fill(v);
function ch(n: number, over: Partial<AidChannels> = {}): AidChannels {
  return {
    abs: filled(n, 0), tc: filled(n, 0), brake: filled(n, 0), throttle: filled(n, 0),
    slip_fl: filled(n, 1), slip_fr: filled(n, 1), slip_rl: filled(n, 1), slip_rr: filled(n, 1), ...over,
  };
}

describe("slipRatio", () => {
  it("is wheel speed over ground speed", () => {
    expect(slipRatio(45, 50)).toBeCloseTo(0.9);
    expect(slipRatio(55, 50)).toBeCloseTo(1.1);
    expect(slipRatio(50, 50)).toBe(1);
  });
  it("reads 1 (no division) below the minimum speed, including standing still", () => {
    expect(slipRatio(0.1, 0)).toBe(1);
    expect(slipRatio(3, 0)).toBe(1);
    expect(slipRatio(2, MIN_SLIP_SPEED_MS - 0.01)).toBe(1);
    expect(slipRatio(2.5, MIN_SLIP_SPEED_MS)).toBeCloseTo(0.5);
  });
});

describe("runsOf", () => {
  it("returns inclusive runs and bridges small gaps", () => {
    const f = [0, 1, 1, 0, 1, 0, 0, 0, 1];
    expect(runsOf((i) => f[i] > 0, f.length)).toEqual([{ start: 1, end: 2 }, { start: 4, end: 4 }, { start: 8, end: 8 }]);
    expect(runsOf((i) => f[i] > 0, f.length, 1)).toEqual([{ start: 1, end: 4 }, { start: 8, end: 8 }]);
    expect(runsOf(() => false, 5)).toEqual([]);
  });
});

describe("aidRuns", () => {
  it("copies the ABS and TC flags", () => {
    const r = aidRuns(ch(6, { abs: [0, 1, 1, 0, 0, 1], tc: [1, 0, 0, 0, 0, 0] }));
    expect(r.abs).toEqual([{ start: 1, end: 2 }, { start: 5, end: 5 }]);
    expect(r.tc).toEqual([{ start: 0, end: 0 }]);
  });
  it("flags a lockup when any wheel is under the limit while braking, not when off the brake", () => {
    const slip = [1, LOCKUP_SLIP - 0.01, LOCKUP_SLIP - 0.01, LOCKUP_SLIP, 1];
    const braking = aidRuns(ch(5, { brake: filled(5, 1), slip_fr: slip }));
    expect(braking.lockup).toEqual([{ start: 1, end: 2 }]);
    expect(aidRuns(ch(5, { brake: filled(5, 0), slip_fr: slip })).lockup).toEqual([]);
  });
  it("flags wheelspin only on a driven wheel while on throttle", () => {
    const slip = [1, WHEELSPIN_SLIP + 0.05, WHEELSPIN_SLIP, 1];
    expect(aidRuns(ch(4, { throttle: filled(4, 1), slip_rr: slip })).wheelspin).toEqual([{ start: 1, end: 1 }]);
    expect(aidRuns(ch(4, { throttle: filled(4, 1), slip_fl: slip })).wheelspin).toEqual([]);
    expect(aidRuns(ch(4, { throttle: filled(4, 0), slip_rr: slip })).wheelspin).toEqual([]);
  });
  it("a wheel running slow in the rear under braking is a lockup, but fast wheels are not", () => {
    expect(aidRuns(ch(3, { brake: filled(3, 1), slip_rl: filled(3, 1.3) })).lockup).toEqual([]);
  });
});

describe("mapSpan", () => {
  it("widens by one metre, clamped to the last index", () => {
    expect(mapSpan({ start: 3, end: 3 }, 10)).toEqual([3, 4]);
    expect(mapSpan({ start: 9, end: 10 }, 10)).toEqual([9, 10]);
  });
});
