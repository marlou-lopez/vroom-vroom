import { describe, expect, it } from "vitest";
import { OFF_TRACK_SURFACES, countOffTrack, step } from "../../../../tools/surface-resample.mjs";

// The extractor's wheels_off channel (vroom-pnw.24): count of wheels on grass or gravel, resampled stepwise from the 5 Hz SurfaceTypes.
describe("countOffTrack", () => {
  it("counts only grass (2) and gravel (4); tarmac, kerbs and drains are on track", () => {
    expect([...OFF_TRACK_SURFACES].sort()).toEqual([2, 4]);
    expect(countOffTrack([0, 0, 0, 0])).toBe(0);
    expect(countOffTrack([5, 6, 5, 6])).toBe(0);
    expect(countOffTrack([2, 0, 4, 0])).toBe(2);
    expect(countOffTrack([2, 2, 4, 4])).toBe(4);
    expect(countOffTrack(["2", 0, 0, 0])).toBe(1); // DuckDB rows can carry strings
  });
});

describe("step (stepwise resampling)", () => {
  const t = [0, 0.2, 0.4, 0.6];
  const v = [0, 2, 0, 4];
  it("holds the latest sample at or before the time and never interpolates", () => {
    expect(step(t, v, 0.2)).toBe(2);
    expect(step(t, v, 0.39)).toBe(2);
    expect(step(t, v, 0.4)).toBe(0);
    expect(step(t, v, 0.5999)).toBe(0);
    expect(step(t, v, 0.7)).toBe(4);
    expect(step(t, v, -1)).toBe(0);
  });
  it("only ever yields values that were in the samples", () => {
    for (let x = 0; x <= 0.7; x += 0.013) expect(v).toContain(step(t, v, x));
  });
});
