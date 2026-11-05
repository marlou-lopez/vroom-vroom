import { describe, expect, it } from "vitest";
import { GRID_CHANNELS, type ChannelArrays, type CompareResponse, type GridChannel } from "../api/types";
import { buildModel, MAP_H, MAP_PAD, MAP_W } from "./model";

/** A square-ish loop of `n` points; every channel not given is zero. */
function channels(n: number, over: Partial<Record<GridChannel, number[]>> = {}): ChannelArrays {
  const base = Object.fromEntries(GRID_CHANNELS.map((k) => [k, new Array<number>(n).fill(0)])) as ChannelArrays;
  return { ...base, ...over };
}

function cmp(n: number, lap: Partial<Record<GridChannel, number[]>>, ref: Partial<Record<GridChannel, number[]>>, delta?: number[]): CompareResponse {
  return {
    lap_id: "l", ref_lap_id: "r", lap_kind: "flying", ref_kind: "flying",
    distance: Array.from({ length: n }, (_, i) => i),
    lap: channels(n, lap), ref: channels(n, ref), delta: delta ?? new Array<number>(n).fill(0),
    warning: null, lap_steering_range_deg: null, ref_steering_range_deg: null, lap_car_dims: null, ref_car_dims: null,
  };
}

const ring = (n: number) => ({
  lat: Array.from({ length: n }, (_, i) => 50 + 0.01 * Math.sin((2 * Math.PI * i) / n)),
  lon: Array.from({ length: n }, (_, i) => 5 + 0.01 * Math.cos((2 * Math.PI * i) / n)),
});

describe("buildModel", () => {
  const n = 40;
  const t = Array.from({ length: n }, (_, i) => i * 2.5);

  it("keeps the comparison and takes the duration from the last time sample", () => {
    const c = cmp(n, { t, speed_kmh: new Array<number>(n).fill(100) }, { ...ring(n), speed_kmh: new Array<number>(n).fill(100) });
    const m = buildModel(c);
    expect(m.cmp).toBe(c);
    expect(m.duration).toBe(t[n - 1]);
  });

  it("rounds the speed range outward to multiples of 20 across both laps", () => {
    const lapSpeed = Array.from({ length: n }, (_, i) => 85 + (i % 3));
    const refSpeed = Array.from({ length: n }, (_, i) => 61 + (i % 4) * 60); // 61..241
    const m = buildModel(cmp(n, { t, speed_kmh: lapSpeed }, { ...ring(n), speed_kmh: refSpeed }));
    expect(m.speedRange).toEqual([60, 260]);
  });

  it("leaves exact multiples of 20 alone", () => {
    const m = buildModel(cmp(n, { t, speed_kmh: new Array<number>(n).fill(120) }, { ...ring(n), speed_kmh: new Array<number>(n).fill(200) }));
    expect(m.speedRange).toEqual([120, 200]);
  });

  it("builds the map projection from the reference lap GPS, inside the padded box", () => {
    const m = buildModel(cmp(n, { t }, ring(n)));
    expect(m.proj.x).toHaveLength(n);
    expect(m.proj.y).toHaveLength(n);
    expect(m.mapPath.startsWith("M")).toBe(true);
    for (const x of m.proj.x) {
      expect(x).toBeGreaterThanOrEqual(-1e-6);
      expect(x).toBeLessThanOrEqual(MAP_W + 1e-6);
    }
    for (const y of m.proj.y) {
      expect(y).toBeGreaterThanOrEqual(-1e-6);
      expect(y).toBeLessThanOrEqual(MAP_H + 1e-6);
    }
    expect(MAP_PAD).toBeGreaterThan(0);
  });

  it("builds a scrubber path from the lap time and delta", () => {
    const delta = t.map((_, i) => Math.sin(i / 5) * 0.3);
    const m = buildModel(cmp(n, { t }, ring(n), delta));
    expect(m.scrubPath.length).toBeGreaterThan(0);
  });

  it("copes with an empty comparison: zero duration, default speed range, empty paths", () => {
    const m = buildModel(cmp(0, {}, {}));
    expect(m.duration).toBe(0);
    expect(m.speedRange).toEqual([0, 300]);
    expect(m.proj.x).toEqual([]);
    expect(m.scrubPath).toBe("");
  });
});
