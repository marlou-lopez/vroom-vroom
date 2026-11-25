import { describe, expect, it } from "vitest";
import type { TrackMap } from "../api/types";
import { invalidNotice } from "./invalidLap";

const N = 1000;
const dist = Array.from({ length: N }, (_, i) => i);
const wheels = (from?: number, to?: number) => ({ wheels_off: dist.map((i) => (from !== undefined && i >= from && i <= (to ?? from) ? 4 : 0)) });
const map = (): TrackMap => ({
  length_m: N,
  corners: [{ id: "c1", name: "Raidillon", number: 1, start_m: 300, apex_m: 350, end_m: 400 }],
} as unknown as TrackMap);

describe("invalidNotice", () => {
  it("names the corner and gives a place to seek to for an invalid lap with a hint", () => {
    const n = invalidNotice(false, wheels(380, 395), dist, map())!;
    expect(n.text).toContain("Raidillon exit");
    expect(n.text).not.toMatch(/\d+\s*m\b/);
    expect(n.atM).toBe(380);
  });
  it("says 'near' for a stretch between corners", () => {
    const n = invalidNotice(false, wheels(700, 720), dist, map())!;
    expect(n.text).toMatch(/invalidated near Raidillon/);
  });
  it("invents no place when the lap is invalid without a wheels-off stretch", () => {
    const n = invalidNotice(false, wheels(), dist, map())!;
    expect(n.text).toMatch(/invalid/);
    expect(n.text).toMatch(/doesn't show where/);
    expect(n.atM).toBeNull();
  });
  it("shows nothing for a valid lap", () => {
    expect(invalidNotice(true, wheels(380, 395), dist, map())).toBeNull();
  });
  it("without a corner list keeps the metres out of the prose", () => {
    const n = invalidNotice(false, wheels(380, 395), dist, null)!;
    expect(n.text).not.toMatch(/\d/);
    expect(n.atM).toBe(380);
  });
});
