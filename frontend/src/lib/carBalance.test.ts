import { describe, expect, it } from "vitest";
import { balanceEnabled, balanceRuns, balanceTrace, fitBalance, smooth, type BalanceChannels } from "./carBalance";

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
