import { describe, expect, it } from "vitest";
import { placeMapLabels, type MapLabel } from "./mapLabels";

const hit = (a: MapLabel, b: MapLabel) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;

describe("placeMapLabels", () => {
  it("keeps a lone label next to its anchor without a leader", () => {
    const [l] = placeMapLabels([{ id: "a", text: "Eau Rouge", x: 50, y: 50 }], { fontSize: 6 });
    expect(l.leader).toBe(false);
    expect(Math.hypot(l.x - 50, l.y - 50)).toBeLessThan(40);
  });

  it("separates a chicane's labels that share almost the same spot", () => {
    const anchors = [
      { id: "1", text: "Rettifilo 1", x: 100, y: 100 },
      { id: "2", text: "Rettifilo 2", x: 103, y: 104 },
      { id: "3", text: "Variante 3", x: 99, y: 106 },
      { id: "4", text: "Variante 4", x: 104, y: 99 },
    ];
    const out = placeMapLabels(anchors, { fontSize: 6 });
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) expect(hit(out[i], out[j])).toBe(false);
    expect(out.map((l) => l.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("uses a leader line for a label that had to move away", () => {
    const anchors = Array.from({ length: 8 }, (_, i) => ({ id: String(i), text: `Corner ${i}`, x: 100 + i, y: 100 }));
    const out = placeMapLabels(anchors, { fontSize: 6 });
    expect(out.some((l) => l.leader)).toBe(true);
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) expect(hit(out[i], out[j])).toBe(false);
  });

  it("avoids the track line when a free side exists", () => {
    const line = Array.from({ length: 41 }, (_, i) => ({ x: 60 + i, y: 50 }));
    const [l] = placeMapLabels([{ id: "a", text: "T1", x: 80, y: 50 }], { fontSize: 6, obstacles: line });
    expect(line.some((o) => Math.abs(o.x - l.x) < l.w / 2 && Math.abs(o.y - l.y) < l.h / 2)).toBe(false);
  });

  it("returns nothing for no anchors", () => {
    expect(placeMapLabels([], { fontSize: 6 })).toEqual([]);
  });
});
