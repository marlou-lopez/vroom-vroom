import { describe, expect, it } from "vitest";
import { summarize } from "./perf";

describe("summarize", () => {
  it("gives 60 fps for steady 16.67 ms frames", () => {
    const s = summarize(new Array(60).fill(1000 / 60));
    expect(s.fps).toBeCloseTo(60, 1);
    expect(s.over20).toBe(0);
  });
  it("counts one slow frame among fast ones", () => {
    const s = summarize([...new Array(99).fill(16), 50]);
    expect(s.maxMs).toBe(50);
    expect(s.over20).toBe(1);
    expect(s.p95Ms).toBe(16);
  });
  it("returns zeros for empty input", () => {
    expect(summarize([])).toEqual({ fps: 0, meanMs: 0, p95Ms: 0, maxMs: 0, over20: 0 });
  });
});
