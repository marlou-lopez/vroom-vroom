import { describe, expect, it } from "vitest";
import type { CarSetup } from "../api/types";
import { diffSetups } from "./setupDiff";

const setup = (...rows: [string, string][]): CarSetup => ({ entries: rows.map(([key, value]) => ({ key, label: key.toLowerCase(), value })) });

describe("diffSetups", () => {
  it("is empty for the same setup, whatever the order", () => {
    const a = setup(["A", "1"], ["B", "2"]);
    expect(diffSetups(a, a)).toEqual([]);
    expect(diffSetups(a, setup(["B", "2"], ["A", "1"]))).toEqual([]);
    expect(diffSetups(setup(), setup())).toEqual([]);
  });

  it("reports a changed value from the reference to the lap", () => {
    expect(diffSetups(setup(["WING", "6"], ["ARB", "P1"]), setup(["WING", "8"], ["ARB", "P1"]))).toEqual([
      { key: "WING", label: "wing", from: "6", to: "8" },
    ]);
  });

  it("reports a key only the lap has as added and one only the reference has as removed", () => {
    const changes = diffSetups(setup(["OLD", "x"], ["SAME", "1"]), setup(["SAME", "1"], ["NEW", "y"]));
    expect(changes).toEqual([
      { key: "NEW", label: "new", from: null, to: "y" },
      { key: "OLD", label: "old", from: "x", to: null },
    ]);
  });

  it("treats an empty side as every key added or removed", () => {
    expect(diffSetups(setup(), setup(["A", "1"]))).toHaveLength(1);
    expect(diffSetups(setup(["A", "1"]), setup())).toHaveLength(1);
  });
});
