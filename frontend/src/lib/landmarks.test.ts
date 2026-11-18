import { describe, expect, it } from "vitest";
import type { Corner, Landmark } from "../api/types";
import { groupLandmarks, KIND_NAMES } from "./landmarks";

const corner = (id: string, name: string) => ({ id, name }) as Corner;
const lm = (id: string, corner_id: string | null, distance_m: number) =>
  ({ id, label: id, kind: "custom", distance_m, corner_id, confidence: "detected" }) as Landmark;

describe("groupLandmarks", () => {
  const corners = [corner("c1", "La Source"), corner("c2", "Eau Rouge")];
  it("groups by corner in track order and sorts by distance, no-corner last", () => {
    const g = groupLandmarks([lm("d", null, 5), lm("c", "c2", 900), lm("b", "c1", 300), lm("a", "c1", 100), lm("e", "gone", 50)], corners);
    expect(g.map((x) => x.name)).toEqual(["La Source", "Eau Rouge", "No corner"]);
    expect(g[0].landmarks.map((l) => l.id)).toEqual(["a", "b"]);
    expect(g[2].landmarks.map((l) => l.id)).toEqual(["d", "e"]);
  });
  it("skips corners without landmarks", () => {
    expect(groupLandmarks([lm("x", "c2", 1)], corners).map((x) => x.cornerId)).toEqual(["c2"]);
  });
  it("names every kind readably", () => {
    expect(KIND_NAMES.brake_board).toBe("Brake board");
    expect(Object.values(KIND_NAMES).every((n) => !n.includes("_"))).toBe(true);
  });
});
