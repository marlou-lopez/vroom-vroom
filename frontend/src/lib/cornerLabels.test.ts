import { describe, expect, it } from "vitest";
import { layoutCornerLabels, shortCorner } from "./cornerLabels";

describe("shortCorner", () => {
  it("makes short codes", () => {
    expect(shortCorner("Rettifilo 2")).toBe("R2");
    expect(shortCorner("Les Combes 1")).toBe("LC1");
    expect(shortCorner("Eau Rouge")).toBe("ER");
    expect(shortCorner("T9")).toBe("T9");
    expect(shortCorner("Bruxelles")).toBe("Bru");
  });
});

describe("layoutCornerLabels", () => {
  const mk = (id: string, name: string, frac: number, priority = false) => ({ id, name, frac, priority });
  it("shows full names when there is room", () => {
    const r = layoutCornerLabels([mk("a", "Rettifilo 1", 0.1), mk("b", "Parabolica", 0.8)], 1000);
    expect(r.map((l) => l.mode)).toEqual(["full", "full"]);
  });
  it("falls back to the short code before a dot", () => {
    // 60 px apart: full names (~70 px) collide, short codes (~19 px) fit.
    const r = layoutCornerLabels([mk("a", "Rettifilo 1", 0.1), mk("b", "Rettifilo 2", 0.16)], 1000);
    expect(r.map((l) => l.text)).toEqual(["Rettifilo 1", "R2"]);
  });
  it("dots a non-priority corner when even the code does not fit", () => {
    const r = layoutCornerLabels([mk("a", "Rettifilo 1", 0.1), mk("b", "Rettifilo 2", 0.101)], 1000);
    expect(r[1].mode).toBe("dot");
  });
  it("keeps priority corners' labels over their neighbours", () => {
    const r = layoutCornerLabels([mk("a", "Roggia 1", 0.5), mk("b", "Roggia 2", 0.51, true)], 1000);
    expect(r[1].mode).not.toBe("dot");
    expect(r[1].text).toBe("Roggia 2");
    expect(r[0].mode).not.toBe("full");
  });
  it("never drops a priority label even when crowded", () => {
    const r = layoutCornerLabels([mk("a", "Ascari 1", 0.5, true), mk("b", "Ascari 2", 0.5, true)], 1000);
    expect(r.every((l) => l.mode !== "dot")).toBe(true);
  });
});

describe("layoutCornerLabels sizing", () => {
  it("gives every label at least 24 px and widens with the font size", () => {
    const mk = (id: string, name: string, frac: number) => ({ id, name, frac, priority: false });
    const items = [mk("a", "Rettifilo 1", 0.1), mk("b", "Rettifilo 2", 0.18)];
    expect(layoutCornerLabels(items, 1000, 11)[1].mode).toBe("full");
    expect(layoutCornerLabels(items, 1000, 14)[1].mode).toBe("short");
  });
});
