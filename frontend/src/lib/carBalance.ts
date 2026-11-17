import type { ChannelArrays } from "../api/types";
import type { BalanceRun } from "../api/types";
import { runsOf, type Run } from "./driverAids";

// Experimental (vroom-pnw.15): under- and oversteer estimated from a recording, which has no yaw rate or slip angle.
// Method and how well it matches the shared-memory truth: docs/car-behaviour/oversteer-understeer.md.
//
// The path's yaw rate comes from lateral g (r = a_y / v). The yaw rate the steering asks for comes from a per-car
// steady-state fit, steering-wheel angle = a * curvature + b * curvature * v^2 + c, made on the driver's own laps. The
// balance is the difference, signed by the direction of the turn: more rotation asked for than the car made is
// understeer (> 0), more rotation than asked for, or counter-steer, is oversteer (< 0). Because the fit is the driver's
// own average, zero means "your usual balance in this car", not a neutral car.

const G = 9.81;
/** Below this speed (m/s) the balance is not computed: hairpins at walking pace and the pit lane are not cornering at the limit. */
export const MIN_BALANCE_SPEED_MS = 15;
/** Centred moving average of steering and lateral g, +- this many metres. */
export const SMOOTH_HALF_M = 4;
/** Below this path yaw rate (deg/s) the turn direction comes from the steering instead (a straight has no direction). */
const MIN_TURN_DEG_S = 2;
/**
 * Balance (deg/s) beyond which a metre is marked as understeer. Against the capture truth on Spa corners (relative to the
 * car's usual balance): precision 0.74, recall 0.89 (docs/car-behaviour/oversteer-understeer.md).
 */
export const BALANCE_MARK_DEG_S = 5;
/**
 * Oversteer needs more: on corner metres where the truth has no oversteer, the estimate still reaches -6.9 deg/s at its 1st
 * percentile. At 7 deg/s precision is 0.88 and recall 0.45; at 5, 40 % of the marks are false. A steering-lag model doesn't
 * help: the entry and exit dip is in the truth too (vroom-bi4.7, docs/car-behaviour/oversteer-understeer.md).
 */
export const OVERSTEER_MARK_DEG_S = 7;
/** Marks only count in corners: at least this much lateral g, or (oversteer) a counter-steer. */
export const MARK_MIN_G = 0.5;
/** Marks closer than this many metres merge into one run. */
const MERGE_GAP_M = 3;
/** Runs shorter than this many metres are dropped as noise. */
const MIN_RUN_M = 5;

/** `wheels_off` is optional: when given, metres with a wheel off the track are left out of the fit (as balance_check.py does). */
export type BalanceChannels = Pick<ChannelArrays, "speed_kmh" | "steering" | "g_lat"> & Partial<Pick<ChannelArrays, "wheels_off">>;

/** Steering-wheel angle (deg, left +) = a * curvature (1/m, left +) + b * curvature * v^2 + c. */
export interface BalanceFit { a: number; b: number; c: number; n: number }

export function smooth(v: readonly number[], half: number): number[] {
  const n = v.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + v[i];
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half);
    out[i] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
  }
  return out;
}

interface Prepared { v: number[]; kappa: number[]; theta: number[]; gLat: number[] }

function prepare(ch: BalanceChannels, rangeDeg: number): Prepared {
  const gLat = smooth(ch.g_lat, SMOOTH_HALF_M);
  const steer = smooth(ch.steering, SMOOTH_HALF_M);
  const v = ch.speed_kmh.map((s) => s / 3.6);
  return {
    v, gLat,
    kappa: v.map((s, i) => (s > 0 ? (G * gLat[i]) / (s * s) : 0)),
    // steering + is right; the fit works left-positive like lateral g.
    theta: steer.map((s) => (-s * rangeDeg) / 2),
  };
}

/** Least squares of [kappa, kappa*v^2, 1] on theta over every metre at or above the minimum speed with no wheel off, of every lap given. null when too few. */
export function fitBalance(laps: readonly BalanceChannels[], rangeDeg: number): BalanceFit | null {
  // Normal equations, 3x3.
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const r = [0, 0, 0];
  let n = 0;
  for (const ch of laps) {
    const p = prepare(ch, rangeDeg);
    for (let i = 0; i < p.v.length; i++) {
      if (p.v[i] < MIN_BALANCE_SPEED_MS || (ch.wheels_off?.[i] ?? 0) > 0) continue;
      const x = [p.kappa[i], p.kappa[i] * p.v[i] * p.v[i], 1];
      for (let j = 0; j < 3; j++) {
        r[j] += x[j] * p.theta[i];
        for (let k = 0; k < 3; k++) m[3 * j + k] += x[j] * x[k];
      }
      n++;
    }
  }
  if (n < 50) return null;
  const s = solve3(m, r);
  return s && { a: s[0], b: s[1], c: s[2], n };
}

function solve3(m: number[], r: number[]): number[] | null {
  const det = (a: number[]) =>
    a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  const d = det(m);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-30) return null;
  return [0, 1, 2].map((col) => det(m.map((v, i) => (i % 3 === col ? r[Math.floor(i / 3)] : v))) / d);
}

/**
 * Balance per metre in deg/s: > 0 understeer, < 0 oversteer, NaN where not computed (too slow). `expected` and `actual`
 * are the yaw rates (deg/s, left +) the steering asks for and the path makes.
 */
export function balanceTrace(ch: BalanceChannels, rangeDeg: number, fit: BalanceFit): { balance: number[]; expected: number[]; actual: number[] } {
  const p = prepare(ch, rangeDeg);
  const n = p.v.length;
  const balance = new Array<number>(n), expected = new Array<number>(n), actual = new Array<number>(n);
  const deg = 180 / Math.PI;
  for (let i = 0; i < n; i++) {
    const v = p.v[i];
    const gain = fit.a + fit.b * v * v;
    if (v < MIN_BALANCE_SPEED_MS || gain <= 0) {
      balance[i] = expected[i] = actual[i] = NaN;
      continue;
    }
    const rExp = (v * (p.theta[i] - fit.c) / gain) * deg;
    const rAct = v * p.kappa[i] * deg;
    const sign = Math.abs(rAct) > MIN_TURN_DEG_S ? Math.sign(rAct) : Math.sign(rExp);
    expected[i] = rExp;
    actual[i] = rAct;
    balance[i] = sign * (rExp - rAct);
  }
  return { balance, expected, actual };
}

export interface BalanceRuns { understeer: Run[]; oversteer: Run[] }

/** Stretches marked as understeer (past `BALANCE_MARK_DEG_S`) or oversteer (past `OVERSTEER_MARK_DEG_S`), in a corner, at least `MIN_RUN_M` long. */
export function balanceRuns(ch: BalanceChannels, trace: { balance: number[]; expected: number[]; actual: number[] }): BalanceRuns {
  const gLat = smooth(ch.g_lat, SMOOTH_HALF_M);
  const n = trace.balance.length;
  const counter = (i: number) => Math.sign(trace.expected[i]) !== Math.sign(trace.actual[i]) && Math.abs(trace.actual[i]) > MIN_TURN_DEG_S;
  const keep = (rs: Run[]) => rs.filter((r) => r.end - r.start + 1 >= MIN_RUN_M);
  return {
    understeer: keep(runsOf((i) => trace.balance[i] > BALANCE_MARK_DEG_S && Math.abs(gLat[i]) >= MARK_MIN_G, n, MERGE_GAP_M)),
    oversteer: keep(runsOf((i) => trace.balance[i] < -OVERSTEER_MARK_DEG_S && (Math.abs(gLat[i]) >= MARK_MIN_G || counter(i)), n, MERGE_GAP_M)),
  };
}

/** The whole estimate for a comparison: one fit on both laps (same car) or one per lap, then each lap's trace and runs. */
export function compareBalance(
  lap: BalanceChannels, ref: BalanceChannels,
  lapRangeDeg: number | null, refRangeDeg: number | null, sameCar: boolean,
): { lap: { balance: number[]; runs: BalanceRuns } | null; ref: { balance: number[]; runs: BalanceRuns } | null } {
  const one = (ch: BalanceChannels, range: number | null, fit: BalanceFit | null) => {
    if (range === null || !fit) return null;
    const t = balanceTrace(ch, range, fit);
    return { balance: t.balance, runs: balanceRuns(ch, t) };
  };
  if (sameCar && lapRangeDeg !== null && lapRangeDeg === refRangeDeg) {
    const fit = fitBalance([lap, ref], lapRangeDeg);
    return { lap: one(lap, lapRangeDeg, fit), ref: one(ref, refRangeDeg, fit) };
  }
  return {
    lap: one(lap, lapRangeDeg, lapRangeDeg === null ? null : fitBalance([lap], lapRangeDeg)),
    ref: one(ref, refRangeDeg, refRangeDeg === null ? null : fitBalance([ref], refRangeDeg)),
  };
}

/** `?balance` (or `?balance=1`) turns the experimental balance strip and map tint on; anything else leaves them off. */
export function balanceEnabled(search: string): boolean {
  const v = new URLSearchParams(search).get("balance");
  return v !== null && v !== "0" && v !== "false";
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** The API shape of a balance trace: one decimal, null where not computed. */
export const balanceForApi = (balance: readonly number[]): (number | null)[] => balance.map((b) => (Number.isFinite(b) ? r1(b) : null));

/** The API shape of runs (inclusive grid metres). */
export const runsForApi = (runs: readonly Run[]): BalanceRun[] => runs.map((r) => ({ start_m: r.start, end_m: r.end }));

/**
 * Peak and mean understeer of one corner from a balance trace (understeer only, never oversteer). `startM` / `endM` are grid
 * metres; a corner that wraps over the start line (start > end) is measured across it. Both null when no metre has a balance.
 * Peak is the largest balance, floored at 0. Mean is over the metres past `BALANCE_MARK_DEG_S` only (0 when there are none).
 */
export function cornerUndersteer(
  balance: ArrayLike<number | null> | null, startM: number, endM: number,
): { peak: number; mean: number } | null {
  if (!balance || balance.length === 0) return null;
  const last = balance.length - 1;
  const s = Math.min(Math.round(startM), last), e = Math.min(Math.round(endM), last);
  let peak = -Infinity, sum = 0, count = 0, seen = false;
  const visit = (i: number) => {
    const b = balance[i];
    if (b === null || !Number.isFinite(b)) return;
    seen = true;
    peak = Math.max(peak, b);
    if (b > BALANCE_MARK_DEG_S) { sum += b; count++; }
  };
  if (s <= e) for (let i = s; i <= e; i++) visit(i);
  else { for (let i = s; i <= last; i++) visit(i); for (let i = 0; i <= e; i++) visit(i); }
  return seen ? { peak: r1(Math.max(0, peak)), mean: count ? r1(sum / count) : 0 } : null;
}
