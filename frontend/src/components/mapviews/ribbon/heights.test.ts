import { describe, expect, it } from "vitest";
import { heightAt, roadHeights } from "./heights";

describe("roadHeights", () => {
  it("is null without elevation, and when every entry is null", () => {
    expect(roadHeights(null, 10)).toBeNull();
    expect(roadHeights(undefined, 10)).toBeNull();
    expect(roadHeights([null, null, null], 3)).toBeNull();
  });

  it("uses the heights that exist, cut or padded to n", () => {
    const e = [10, null, 20, 20, 20, 20, 20];
    const h = roadHeights(e, 7)!;
    expect(h[5]).toBeCloseTo(20, 6);
    expect(h[6]).toBeCloseTo(20, 6);
    expect(roadHeights(e, 4)!.length).toBe(4);
    const padded = roadHeights([3, 3], 5)!;
    expect(Array.from(padded)).toEqual([3, 3, 3, 3, 3]); // the end holds the nearest height
  });

  it("interpolates gaps linearly and holds the ends", () => {
    const flat = Array(40).fill(null) as (number | null)[];
    flat[10] = 0;
    flat[30] = 20;
    const h = roadHeights(flat, 40)!;
    expect(h[0]).toBeCloseTo(0, 3); // leading gap holds the first height
    expect(h[39]).toBeCloseTo(20, 3); // trailing gap holds the last
    expect(h[20]).toBeCloseTo(10, 1); // middle of the ramp
    for (let i = 11; i < 30; i++) expect(h[i]).toBeGreaterThanOrEqual(h[i - 1] - 1e-9); // monotone ramp
  });

  it("smooths a spike without moving a plateau", () => {
    const lap = Array(21).fill(5) as number[];
    lap[10] = 15;
    const h = roadHeights(lap, 21)!;
    expect(h[10]).toBeLessThan(15);
    expect(h[10]).toBeGreaterThan(5);
    expect(h[0]).toBeCloseTo(5, 6);
  });

  it("has one height per grid index", () => {
    expect(roadHeights([1, 2, 3], 3)!.length).toBe(3);
  });
});

describe("heightAt", () => {
  it("interpolates and clamps", () => {
    const h = Float64Array.from([0, 10, 20]);
    expect(heightAt(h, 0.5)).toBe(5);
    expect(heightAt(h, -3)).toBe(0);
    expect(heightAt(h, 99)).toBe(20);
  });
});
