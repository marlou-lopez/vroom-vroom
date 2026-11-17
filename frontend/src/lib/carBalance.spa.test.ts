/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BALANCE_MARK_DEG_S, balanceRuns, balanceTrace, fitBalance, smooth, type BalanceChannels } from "./carBalance";

// Spa 2026-11-05 flying lap with the shared-memory truth (tools/lmu-logger/balance_check.py --fixture): T is the front minus
// rear slip angle into the turn (+ understeer), from the capture of the same session.
interface Fixture { steering_range_deg: number; speed_kmh_x10: number[]; steering_x1000: number[]; g_lat_mg: number[]; T_cdeg: number[] }
const FX = JSON.parse(gunzipSync(readFileSync(fileURLToPath(new URL("./fixtures/spa-balance-2026-11-05.json.gz", import.meta.url)))).toString()) as Fixture;
const ch: BalanceChannels = {
  speed_kmh: FX.speed_kmh_x10.map((v) => v / 10),
  steering: FX.steering_x1000.map((v) => v / 1000),
  g_lat: FX.g_lat_mg.map((v) => v / 1000),
};
const T = FX.T_cdeg.map((v) => v / 100);

function pearson(x: number[], y: number[]): number {
  const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
}

describe("balance estimate against the capture truth, Spa flying lap", () => {
  const fit = fitBalance([ch], FX.steering_range_deg)!;
  const t = balanceTrace(ch, FX.steering_range_deg, fit);
  const g = smooth(ch.g_lat, 4);
  const corner = t.balance.map((b, i) => Number.isFinite(b) && Math.abs(g[i]) > 0.5);

  it("follows the true front-minus-rear slip angle through the corners", () => {
    const b = t.balance.filter((_, i) => corner[i]), tt = T.filter((_, i) => corner[i]);
    expect(b.length).toBeGreaterThan(1500);
    expect(pearson(b, tt)).toBeGreaterThan(0.8);
  });

  it("stays quiet on the Kemmel straight (1500-2150 m)", () => {
    const k = t.balance.slice(1500, 2150).filter(Number.isFinite);
    expect(Math.max(...k.map(Math.abs))).toBeLessThan(BALANCE_MARK_DEG_S);
  });

  it("marks Pouhon and the Bus Stop", () => {
    const runs = balanceRuns(ch, t);
    const all = [...runs.understeer, ...runs.oversteer];
    const hit = (lo: number, hi: number) => all.some((r) => r.end >= lo && r.start <= hi);
    expect(hit(3650, 4100)).toBe(true); // Pouhon
    expect(hit(6550, 6750)).toBe(true); // Bus Stop
  });
});
