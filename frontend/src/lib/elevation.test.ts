import { describe, expect, it } from "vitest";
import {
  buildElevationIndex, elevationAt, elevationProfile, latLonToWorld, type ElevationTrack,
} from "./elevation";

// A straight 100 m road along +x at z = 0 climbing 10 m, then a separate lap 1000 m away at z = 500.
const ROAD: ElevationTrack = {
  source: "test", track: "t",
  points: [
    ...Array.from({ length: 101 }, (_, i): [number, number, number] => [i, 0, i / 10]),
    ...Array.from({ length: 11 }, (_, i): [number, number, number] => [1000 + i, 500, 50]),
  ],
  laps: [
    { lap: 0, start_index: 0, end_index: 101, lap_time_s: null },
    { lap: 1, start_index: 101, end_index: 112, lap_time_s: null },
  ],
};

describe("latLonToWorld", () => {
  it("is the inverse of LMU's GPS: lat 60 / lon 0 at the origin, 1 degree of latitude about 111.2 km", () => {
    expect(latLonToWorld(60, 0)).toEqual({ x: 0, z: 0 });
    const p = latLonToWorld(61, 0);
    expect(p.z).toBeGreaterThan(111_000);
    expect(p.z).toBeLessThan(111_400);
    // a degree of longitude is half as long at 60 degrees north
    expect(latLonToWorld(60, 1).x / p.z).toBeCloseTo(0.5, 3);
  });
});

describe("elevationAt", () => {
  const idx = buildElevationIndex(ROAD);

  it("interpolates along the nearest segment", () => {
    expect(elevationAt(idx, 50, 0)).toBeCloseTo(5, 6);
    expect(elevationAt(idx, 50.5, 2)).toBeCloseTo(5.05, 6);
    expect(elevationAt(idx, 1005, 500)).toBeCloseTo(50, 6);
  });

  it("is null farther than 5 m from the path, also across bucket borders", () => {
    expect(elevationAt(idx, 50, 5.5)).toBeNull();
    expect(elevationAt(idx, 50, 4.9)).not.toBeNull();
    expect(elevationAt(idx, 9.9, 4.9)).not.toBeNull();
    expect(elevationAt(idx, 500, 500)).toBeNull();
    expect(elevationAt(idx, 50, 8, 10)).toBeCloseTo(5, 6);
  });

  it("clamps beyond the ends of the path", () => {
    expect(elevationAt(idx, 102, 0)).toBeCloseTo(10, 6);
    expect(elevationAt(idx, 106, 0)).toBeNull();
  });

  it("does not join laps into one polyline", () => {
    // Midway between the end of lap 0 and the start of lap 1 nothing is near anyway; each lap stays separate.
    expect(elevationAt(idx, 100, 0)).toBeCloseTo(10, 6);
    expect(elevationAt(idx, 1000, 500)).toBeCloseTo(50, 6);
  });

  it("ignores teleport jumps inside a lap", () => {
    const jump: ElevationTrack = {
      ...ROAD, points: [[0, 0, 0], [1, 0, 0], [200, 0, 99], [201, 0, 99]],
      laps: [{ lap: 0, start_index: 0, end_index: 4, lap_time_s: null }],
    };
    const j = buildElevationIndex(jump);
    expect(elevationAt(j, 100, 0)).toBeNull();
    expect(elevationAt(j, 0.5, 0)).toBeCloseTo(0, 6);
  });
});

describe("elevationProfile", () => {
  it("converts lat/lon and keeps nulls where there is no path", () => {
    const idx = buildElevationIndex(ROAD);
    // lat 60 / lon 0 is the world origin (y = 0 on the road); 60.0001 is about 11 m north of the road
    const out = elevationProfile(idx, [60, 60.0001], [0, 0]);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeNull();
  });
});
