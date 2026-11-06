import { describe, expect, it } from "vitest";
import { MIRROR_FOV_DEG, mirrorLookDirection } from "./cockpitMirror";
import { MIRROR_PX } from "./cockpitLayout";

describe("mirrorLookDirection", () => {
  it("turns the horizontal part of the view round and keeps the up and down part", () => {
    expect(mirrorLookDirection({ x: 0, y: -0.1, z: -1 })).toEqual([-0, -0.1, 1]);
    expect(mirrorLookDirection({ x: 0.6, y: 0.2, z: -0.8 })).toEqual([-0.6, 0.2, 0.8]);
  });
  it("keeps a unit vector unit", () => {
    const d = mirrorLookDirection({ x: 0.36, y: 0.48, z: -0.8 });
    expect(Math.hypot(...d)).toBeCloseTo(1, 9);
  });
});

describe("mirror picture", () => {
  it("is wide and shallow: about 74 degrees across at the glass's aspect", () => {
    const aspect = MIRROR_PX[0] / MIRROR_PX[1];
    const horizontal = 2 * Math.atan(Math.tan((MIRROR_FOV_DEG * Math.PI) / 360) * aspect) * (180 / Math.PI);
    expect(horizontal).toBeGreaterThan(60);
    expect(horizontal).toBeLessThan(90);
  });
});
