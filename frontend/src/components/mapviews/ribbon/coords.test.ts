import { describe, expect, it } from "vitest";
import { headingDir, toThree, writeThree } from "./coords";

describe("scene to three.js coordinates", () => {
  it("maps east to x, north to -z and height (times the exaggeration) to y", () => {
    expect(toThree(10, 20, 5)).toEqual({ x: 10, y: 5, z: -20 });
    expect(toThree(10, 20, 5, 3)).toEqual({ x: 10, y: 15, z: -20 });
  });

  it("writeThree stores the unexaggerated position", () => {
    const out = new Float32Array(6);
    writeThree(out, 1, 1, 2, 3);
    expect(Array.from(out)).toEqual([0, 0, 0, 1, 3, -2]);
  });

  it("headings: east is +x, north is -z", () => {
    const e = headingDir(0), n = headingDir(Math.PI / 2);
    expect(e.x).toBeCloseTo(1); expect(e.z).toBeCloseTo(0);
    expect(n.x).toBeCloseTo(0); expect(n.z).toBeCloseTo(-1);
  });
});
