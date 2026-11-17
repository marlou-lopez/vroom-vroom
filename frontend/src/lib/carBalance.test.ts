import { describe, expect, it } from "vitest";
import { balanceFromContract, balanceEnabled, balanceForApi, cornerUndersteer, runsForApi, balanceRuns, balanceTrace, fitBalance, smooth, type BalanceChannels } from "./carBalance";

const RANGE = 540;
// A car whose steering follows theta = A*kappa + B*kappa*v^2 exactly (deg of wheel, left +).
const A = 2800, B = 1.2;

/** A lap of constant-radius corners at varying speeds; `extra(i)` adds steering (deg, left +) at metre i. */
function lap(n: number, extra: (i: number) => number = () => 0): BalanceChannels {
  const speed_kmh: number[] = [], steering: number[] = [], g_lat: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = 25 + 15 * Math.sin(i / 150);
    const kappa = 0.01 * Math.sin(i / 60); // left and right corners, radius >= 100 m
    const theta = A * kappa + B * kappa * v * v + extra(i);
    speed_kmh.push(v * 3.6);
    steering.push((-theta * 2) / RANGE);
    g_lat.push((v * v * kappa) / 9.81);
  }
  return { speed_kmh, steering, g_lat };
}

describe("smooth", () => {
  it("is a centred mean that shrinks at the ends", () => {
    expect(smooth([0, 3, 6, 9], 1)).toEqual([1.5, 3, 6, 7.5]);
  });
});

describe("fitBalance", () => {
  it("recovers the steering model of a car that follows it", () => {
    const fit = fitBalance([lap(3000)], RANGE)!;
    expect(fit.a).toBeCloseTo(A, -1);
    expect(fit.b).toBeCloseTo(B, 1);
    expect(Math.abs(fit.c)).toBeLessThan(0.5);
  });
  it("needs enough cornering metres", () => {
    expect(fitBalance([lap(20)], RANGE)).toBeNull();
  });
});

describe("balanceTrace and balanceRuns", () => {
  const fit = { a: A, b: B, c: 0, n: 1000 };
  it("reads zero where the car follows the model", () => {
    const t = balanceTrace(lap(2000), RANGE, fit);
    const worst = Math.max(...t.balance.filter(Number.isFinite).map(Math.abs));
    expect(worst).toBeLessThan(0.6); // only the smoothing's curvature error
  });
  it("marks extra steering into the turn as understeer and less (or counter) as oversteer", () => {
    const n = 2000;
    // Around metre 95 the lap turns left hard (sin peaks); add 40 deg into the turn there, and take 60 deg out at 1035 (right turn peak... in that turn "out" means leftwards).
    const ch = lap(n, (i) => (i >= 80 && i <= 110 ? 40 : i >= 1020 && i <= 1050 ? 60 : 0));
    const t = balanceTrace(ch, RANGE, fit);
    expect(t.balance[95]).toBeGreaterThan(5);
    // Metre 1035: kappa < 0 (right turn); +60 deg is steering left, against the turn.
    expect(t.balance[1035]).toBeLessThan(-5);
    const runs = balanceRuns(ch, t);
    expect(runs.understeer.some((r) => r.start <= 95 && r.end >= 95)).toBe(true);
    expect(runs.oversteer.some((r) => r.start <= 1035 && r.end >= 1035)).toBe(true);
    expect(runs.understeer.some((r) => r.start <= 1035 && r.end >= 1035)).toBe(false);
  });
  it("skips metres below the minimum speed", () => {
    const ch = lap(10);
    ch.speed_kmh.fill(20);
    expect(balanceTrace(ch, RANGE, fit).balance.every(Number.isNaN)).toBe(true);
  });
});

describe("balanceEnabled", () => {
  it("is on only with ?balance", () => {
    expect(balanceEnabled("")).toBe(false);
    expect(balanceEnabled("?balance")).toBe(true);
    expect(balanceEnabled("?balance=1&debug")).toBe(true);
    expect(balanceEnabled("?balance=0")).toBe(false);
    expect(balanceEnabled("?balance=false")).toBe(false);
  });
});

describe("cornerUndersteer", () => {
  const b = [0, 2, 8, 12, 6, 1, -20, 0];
  it("takes the peak and the mean past the mark, and ignores oversteer", () => {
    expect(cornerUndersteer(b, 1, 5)).toEqual({ peak: 12, mean: 8.7 });
    expect(cornerUndersteer(b, 5, 7)).toEqual({ peak: 1, mean: 0 });
  });
  it("floors the peak at 0 and gives null without a balance", () => {
    expect(cornerUndersteer([-3, -8, null], 0, 2)).toEqual({ peak: 0, mean: 0 });
    expect(cornerUndersteer([null, null], 0, 1)).toBeNull();
    expect(cornerUndersteer(null, 0, 1)).toBeNull();
  });
  it("measures a corner across the start line", () => {
    expect(cornerUndersteer(b, 6, 3)?.peak).toBe(12);
  });
});

describe("API shapes", () => {
  it("rounds the trace, nulls NaN and names run bounds in metres", () => {
    expect(balanceForApi([1.234, NaN])).toEqual([1.2, null]);
    expect(runsForApi([{ start: 3, end: 9 }])).toEqual([{ start_m: 3, end_m: 9 }]);
  });
});

describe("balanceFromContract", () => {
  const cmp = {
    lap_balance: [null, 6, 7], ref_balance: null,
    lap_understeer_runs: [{ start_m: 1, end_m: 2 }], lap_oversteer_runs: [{ start_m: 0, end_m: 1 }],
  };
  it("reads the trace and understeer runs from the contract, oversteer only for the preview", () => {
    const off = balanceFromContract(cmp, false)!;
    expect(off.balance).toEqual([null, 6, 7]);
    expect(off.runs).toEqual({ understeer: [{ start: 1, end: 2 }], oversteer: [] });
    expect(balanceFromContract(cmp, true)!.runs.oversteer).toEqual([{ start: 0, end: 1 }]);
  });
  it("is null when the lap has no balance", () => {
    expect(balanceFromContract({ ...cmp, lap_balance: null }, true)).toBeNull();
  });
});
