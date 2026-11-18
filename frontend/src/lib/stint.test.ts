import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { StintLap, Wheels } from "../api/types";
import type { StintFile } from "../api/mock/stint";
import { splitStints } from "../api/mock/stint";
import { falloff, stintSentence, falloffPlot, fuelCorrectedFalloff, GT3_FUEL_EFFECT, SLOW_LAP_FACTOR, stintRows, stintSummary } from "./stint";

const w = (v: number): Wheels => ({ fl: v, fr: v, rl: v, rr: v });
function lap(lap_no: number, over: Partial<StintLap> = {}): StintLap {
  const fuel = 90 - lap_no * 3;
  const energy = 100 - lap_no * 4;
  return {
    lap_id: `lap-${lap_no}`, lap_no, kind: "flying", lap_time_s: 100 + lap_no * 0.1, valid: true,
    fuel_start_l: fuel, fuel_end_l: fuel - 3, energy_start_pct: energy, energy_end_pct: energy - 4,
    tyre_surface_c: w(80), tyre_zones_c: { left: w(78), centre: w(80), right: w(82) }, tyre_carcass_c: w(82),
    tyre_pressure_kpa: w(170), tyre_wear_end_pct: w(100 - (lap_no + 1) * 0.5), brake_c: w(450), track_temp_c: 30, air_temp_c: 20,
    ...over,
  };
}

describe("stintRows", () => {
  it("excludes out, in, invalid and slow laps from the fit", () => {
    const laps = [lap(0, { kind: "out", lap_time_s: 130 }), lap(1), lap(2), lap(3, { valid: false, lap_time_s: 0 }), lap(4, { lap_time_s: 100.4 * SLOW_LAP_FACTOR + 0.5 }), lap(5), lap(6, { kind: "in" })];
    expect(stintRows(laps).map((r) => r.excluded)).toEqual(["out", null, null, "invalid", "slow", null, "in"]);
  });
  it("gives no consumption on a lap where the tank was filled", () => {
    const [r] = stintRows([lap(0, { kind: "out", fuel_end_l: 95, energy_end_pct: 101 })]);
    expect(r.fuelUsed).toBeNull();
    expect(r.energyUsed).toBeNull();
  });
  it("gives no energy use without virtual energy", () => {
    const [r] = stintRows([lap(1, { energy_start_pct: null, energy_end_pct: null })]);
    expect(r.energyUsed).toBeNull();
    expect(r.fuelUsed).toBeCloseTo(3);
  });
});

describe("falloff", () => {
  it("fits the slope in seconds per lap", () => {
    const f = falloff(stintRows([1, 2, 3, 4].map((n) => lap(n))))!;
    expect(f.slope).toBeCloseTo(0.1);
    expect(f.intercept).toBeCloseTo(100);
    expect(f.n).toBe(4);
  });
  it("needs three laps", () => {
    expect(falloff(stintRows([lap(1), lap(2)]))).toBeNull();
  });
});

describe("fuelCorrectedFalloff", () => {
  // 3 L a lap at 0.74 kg/L = 2.22 kg; 0.02 % of a ~100 s lap per kg = 0.02 s/kg, so the burnt fuel gains about 0.0444 s a lap.
  const tyre = 0.1;
  const gain = 0.0002 * 100 * 0.74 * 3;
  const laps = [0, 1, 2, 3, 4, 5, 6].map((n) => lap(n, n === 0 ? { kind: "out", lap_time_s: 130 } : { lap_time_s: 100 + (tyre - gain) * n }));
  it("recovers the tyre-only fall-off hidden under the fuel gain", () => {
    const f = fuelCorrectedFalloff(stintRows(laps))!;
    expect(f.raw.slope).toBeCloseTo(tyre - gain, 3);
    expect(f.slope).toBeCloseTo(tyre, 2);
    expect(f.kgPerLap).toBeCloseTo(2.22, 2);
    expect(f.secPerKg).toBeCloseTo(0.02, 3);
    expect(f.slope).toBeCloseTo(f.raw.slope + f.fuelGainPerLap, 6);
    expect(f.n).toBe(6);
  });
  it("leaves the slope alone with a zero fuel effect", () => {
    const f = fuelCorrectedFalloff(stintRows(laps), { ...GT3_FUEL_EFFECT, lapFractionPerKg: 0 })!;
    expect(f.slope).toBeCloseTo(f.raw.slope, 9);
  });
  it("uses fuel levels, so a missing per-lap reading does not shift the fit", () => {
    const withGap = laps.map((l) => (l.lap_no === 3 ? { ...l, fuel_end_l: l.fuel_start_l + 1 } : l)); // reads as a refuel
    const a = fuelCorrectedFalloff(stintRows(laps))!;
    const b = fuelCorrectedFalloff(stintRows(withGap))!;
    expect(Math.abs(b.slope - a.slope)).toBeLessThan(0.01);
  });
  it("needs a raw fit", () => {
    expect(fuelCorrectedFalloff(stintRows([lap(1), lap(2)]))).toBeNull();
  });
});

describe("stintSummary", () => {
  it("finds which of fuel and energy runs out first", () => {
    const s = stintSummary(stintRows([0, 1, 2, 3].map((n) => lap(n))));
    expect(s.fuelPerLap).toBeCloseTo(3);
    expect(s.energyPerLap).toBeCloseTo(4);
    expect(s.fuelRangeLaps).toBeCloseTo(30);
    expect(s.energyRangeLaps).toBeCloseTo(25);
    expect(s.limit).toBe("energy");
    expect(s.wearPerLap!.fl).toBeCloseTo(0.5);
  });
  it("is fuel-limited without virtual energy", () => {
    const s = stintSummary(stintRows([0, 1, 2].map((n) => lap(n, { energy_start_pct: null, energy_end_pct: null }))));
    expect(s.energyPerLap).toBeNull();
    expect(s.limit).toBe("fuel");
  });
});

describe("falloffPlot", () => {
  it("puts faster laps higher and draws the fit across the fitted laps", () => {
    const rows = stintRows([0, 1, 2, 3, 4].map((n) => lap(n, n === 0 ? { kind: "out", lap_time_s: 130 } : {})));
    const p = falloffPlot(rows, falloff(rows), 1000, 200);
    expect(p.points).toHaveLength(5);
    expect(p.points[1].y).toBeLessThan(p.points[4].y);
    expect(p.points[0].y).toBe(200); // the slow start lap is clamped to the bottom
    expect(p.fit.startsWith("M")).toBe(true);
  });
});

describe("the real Monza race stint (9 Nov 2026)", () => {
  const file = JSON.parse(readFileSync(new URL("../../public/mock/monza-stint-2026-11-09.json", import.meta.url), "utf8")) as StintFile;
  const fileLaps = file.laps.map((l) => ({ ...l, lap_id: `lap-${l.lap_no}` }));
  const rows = stintRows(fileLaps);
  const s = stintSummary(rows);
  it("has 26 laps: start lap, 23 flying, an in lap and the out lap after the stop", () => {
    expect(file.laps).toHaveLength(26);
    expect(file.laps[0].kind).toBe("out");
    expect(file.laps[24].kind).toBe("in");
    expect(file.laps[25].kind).toBe("out");
    expect(rows.filter((r) => r.excluded === null).length).toBeGreaterThanOrEqual(10);
  });
  it("uses about 3.1 L of fuel and 3.8 % of virtual energy a lap, so energy runs out first", () => {
    expect(s.fuelPerLap!).toBeCloseTo(3.1, 1);
    expect(s.energyPerLap!).toBeCloseTo(3.8, 1);
    expect(s.limit).toBe("energy");
  });
  it("wears and heats the left tyres most on the right-handed Monza (wheel order FL FR RL RR)", () => {
    const l5 = file.laps[5];
    expect(l5.tyre_surface_c.fl).toBeGreaterThan(l5.tyre_surface_c.fr);
    expect(l5.tyre_surface_c.rl).toBeGreaterThan(l5.tyre_surface_c.rr);
    expect(l5.brake_c.fl).toBeGreaterThan(l5.brake_c.rl);
    expect(s.wearPerLap!.fl).toBeGreaterThan(s.wearPerLap!.fr);
  });
  it("has a small fall-off: fuel burn and tyre wear nearly cancel", () => {
    expect(Math.abs(s.falloff!.slope)).toBeLessThan(0.15);
  });
  it("about doubles once the fuel gain is taken out (GT3 assumption: about 0.023 s/kg, 2.3 kg a lap)", () => {
    const f = fuelCorrectedFalloff(rows)!;
    expect(f.raw.slope).toBeCloseTo(0.05, 2);
    expect(f.secPerKg).toBeCloseTo(0.0226, 3);
    expect(f.kgPerLap).toBeCloseTo(2.26, 1);
    expect(f.fuelGainPerLap).toBeCloseTo(0.051, 2);
    expect(f.slope).toBeGreaterThan(0.09);
    expect(f.slope).toBeLessThan(0.11);
  });
});

describe("stintSentence", () => {
  const stintsOf = (file: string) => {
    const f = JSON.parse(readFileSync(new URL(`../../public/mock/${file}`, import.meta.url), "utf8")) as StintFile;
    return splitStints(f.laps.map((l, i) => ({ ...l, lap_id: `l${i}` })), f.car_class);
  };
  it("says the pace and what runs out first, for the Monza race (virtual energy)", () => {
    const [st] = stintsOf("monza-stint-2026-11-09.json");
    expect(stintSentence(st)).toBe("You slowed about 0.05 s a lap over the stint; virtual energy runs out first, after about 26 laps.");
  });
  it("uses only numbers from the stint: slope from the API, laps from starting load over mean use", () => {
    const [st] = stintsOf("monza-stint-2026-11-09.json");
    const sum = stintSummary(stintRows(st.laps));
    const nums = stintSentence(st).match(/\d+(\.\d+)?/g)!.map(Number);
    expect(nums).toEqual([Number(Math.abs(st.falloff!.slope_s_per_lap).toFixed(2)), Math.round(sum.energyRangeLaps!)]);
  });
  it("covers each stint of the Spa race, including the short one after the stop, with numbers from the data", () => {
    const stints = stintsOf("spa-race-stint-2026-11-10.json");
    expect(stints.length).toBe(2);
    for (const st of stints) {
      const t = stintSentence(st);
      const sum = stintSummary(stintRows(st.laps));
      expect(t).not.toMatch(/NaN|Infinity|undefined|null/);
      const laps = sum.limit === "energy" ? sum.energyRangeLaps : sum.fuelRangeLaps;
      const expected = [...(st.falloff ? [Number(Math.abs(st.falloff.slope_s_per_lap).toFixed(2))] : []), ...(sum.limit ? [Math.round(laps!)] : [])];
      expect(t.match(/\d+(\.\d+)?/g)?.map(Number) ?? []).toEqual(expected);
    }
  });
  it("is fuel-limited without virtual energy", () => {
    const s = stintSummary(stintRows([0, 1, 2].map((n) => lap(n, { energy_start_pct: null, energy_end_pct: null }))));
    expect(s.energyPerLap).toBeNull();
    expect(s.limit).toBe("fuel");
  });
});

describe("falloffPlot", () => {
  it("puts faster laps higher and draws the fit across the fitted laps", () => {
    const rows = stintRows([0, 1, 2, 3, 4].map((n) => lap(n, n === 0 ? { kind: "out", lap_time_s: 130 } : {})));
    const p = falloffPlot(rows, falloff(rows), 1000, 200);
    expect(p.points).toHaveLength(5);
    expect(p.points[1].y).toBeLessThan(p.points[4].y);
    expect(p.points[0].y).toBe(200); // the slow start lap is clamped to the bottom
    expect(p.fit.startsWith("M")).toBe(true);
  });
});

describe("the real Monza race stint (9 Nov 2026)", () => {
  const file = JSON.parse(readFileSync(new URL("../../public/mock/monza-stint-2026-11-09.json", import.meta.url), "utf8")) as StintFile;
  const fileLaps = file.laps.map((l) => ({ ...l, lap_id: `lap-${l.lap_no}` }));
  const rows = stintRows(fileLaps);
  const s = stintSummary(rows);
  it("has 26 laps: start lap, 23 flying, an in lap and the out lap after the stop", () => {
    expect(file.laps).toHaveLength(26);
    expect(file.laps[0].kind).toBe("out");
    expect(file.laps[24].kind).toBe("in");
    expect(file.laps[25].kind).toBe("out");
    expect(rows.filter((r) => r.excluded === null).length).toBeGreaterThanOrEqual(10);
  });
  it("uses about 3.1 L of fuel and 3.8 % of virtual energy a lap, so energy runs out first", () => {
    expect(s.fuelPerLap!).toBeCloseTo(3.1, 1);
    expect(s.energyPerLap!).toBeCloseTo(3.8, 1);
    expect(s.limit).toBe("energy");
  });
  it("wears and heats the left tyres most on the right-handed Monza (wheel order FL FR RL RR)", () => {
    const l5 = file.laps[5];
    expect(l5.tyre_surface_c.fl).toBeGreaterThan(l5.tyre_surface_c.fr);
    expect(l5.tyre_surface_c.rl).toBeGreaterThan(l5.tyre_surface_c.rr);
    expect(l5.brake_c.fl).toBeGreaterThan(l5.brake_c.rl);
    expect(s.wearPerLap!.fl).toBeGreaterThan(s.wearPerLap!.fr);
  });
  it("has a small fall-off: fuel burn and tyre wear nearly cancel", () => {
    expect(Math.abs(s.falloff!.slope)).toBeLessThan(0.15);
  });
  it("about doubles once the fuel gain is taken out (GT3 assumption: about 0.023 s/kg, 2.3 kg a lap)", () => {
    const f = fuelCorrectedFalloff(rows)!;
    expect(f.raw.slope).toBeCloseTo(0.05, 2);
    expect(f.secPerKg).toBeCloseTo(0.0226, 3);
    expect(f.kgPerLap).toBeCloseTo(2.26, 1);
    expect(f.fuelGainPerLap).toBeCloseTo(0.051, 2);
    expect(f.slope).toBeGreaterThan(0.09);
    expect(f.slope).toBeLessThan(0.11);
  });
});

describe("stintSentence", () => {
  const stintsOf = (file: string) => {
    const f = JSON.parse(readFileSync(new URL(`../../public/mock/${file}`, import.meta.url), "utf8")) as StintFile;
    return splitStints(f.laps.map((l, i) => ({ ...l, lap_id: `l${i}` })), f.car_class);
  };
  it("says the pace and what runs out first, for the Monza race (virtual energy)", () => {
    const [st] = stintsOf("monza-stint-2026-11-09.json");
    expect(stintSentence(st)).toBe("You slowed about 0.05 s a lap over the stint; virtual energy runs out first, after about 26 laps.");
  });
  it("uses only numbers from the stint: slope from the API, laps from starting load over mean use", () => {
    const [st] = stintsOf("monza-stint-2026-11-09.json");
    const sum = stintSummary(stintRows(st.laps));
    const nums = stintSentence(st).match(/\d+(\.\d+)?/g)!.map(Number);
    expect(nums).toEqual([Number(Math.abs(st.falloff!.slope_s_per_lap).toFixed(2)), Math.round(sum.energyRangeLaps!)]);
  });
  it("covers each stint of the Spa race, including the short one after the stop", () => {
    const stints = stintsOf("spa-race-stint-2026-11-10.json");
    expect(stints.length).toBe(2);
    for (const st of stints) {
      const t = stintSentence(st);
      expect(t).toMatch(/^[A-Z][^;]*(; .*)?\.$/);
      expect(t).not.toMatch(/NaN|Infinity|undefined|null/);
    }
  });
  it("is fuel-limited without virtual energy, and says so", () => {
    const laps = [0, 1, 2, 3].map((n) => lap(n, { energy_start_pct: null, energy_end_pct: null }));
    const st = { stint_no: 1, laps, falloff: { slope_s_per_lap: 0.1, n_laps: 4 }, falloff_fuel_corrected: null };
    expect(stintSentence(st)).toBe("You slowed about 0.10 s a lap over the stint; fuel runs out first, after about 30 laps.");
  });
  it("handles a quicker, steady or unfitted stint", () => {
    const laps = [0, 1, 2].map((n) => lap(n));
    const mk = (falloff: { slope_s_per_lap: number; n_laps: number } | null) => stintSentence({ stint_no: 1, laps, falloff, falloff_fuel_corrected: null });
    expect(mk({ slope_s_per_lap: -0.2, n_laps: 3 })).toMatch(/^You got quicker about 0\.20 s a lap/);
    expect(mk({ slope_s_per_lap: 0.001, n_laps: 3 })).toMatch(/^Your lap times stayed steady;/);
    expect(mk(null)).toMatch(/^There are too few clean laps to say how your pace changed;/);
  });
});
