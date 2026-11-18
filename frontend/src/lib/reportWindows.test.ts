/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLASS_WINDOWS, GT3_WINDOWS, WINDOW_UNITS, rangeFor, windowList } from "./reportWindows";
import { FUEL_EFFECT_BY_CLASS } from "../api/mock/stint";

const doc = readFileSync(fileURLToPath(new URL("../../../docs/session-report/windows.md", import.meta.url)), "utf8");
const rows = doc.split("\n").filter((l) => /^\| (GT3|Hypercar|LMP2) /.test(l)).map((l) => l.split("|").map((c) => c.trim()));

describe("report windows", () => {
  it("docs/session-report/windows.md lists every value of the code's table, with its axle, tolerance and a source", () => {
    const keys = Object.keys(WINDOW_UNITS);
    const expected = Object.entries(CLASS_WINDOWS).flatMap(([cls, ws]) => windowList(ws).map((x) => ({ cls, ws, x })));
    expect(rows.length).toBe(expected.length);
    expect(new Set(expected.map((e) => e.x.key))).toEqual(new Set(keys));
    for (const { cls, ws, x } of expected) {
      const row = rows.find((c) => c[1] === cls && c[3] === x.key && c[4] === x.axle);
      expect(row, `${cls} ${x.key} ${x.axle}`).toBeDefined();
      expect([row![2], Number(row![5]), Number(row![6]), Number(row![7]), row![8]]).toEqual([ws.compound, x.min, x.max, x.tolerance, x.unit]);
      expect(row![9].length).toBeGreaterThan(0);
      expect(x.source.length).toBeGreaterThan(0);
    }
  });

  it("keeps the published tyre surface window and uses per-axle windows where the measurements differ", () => {
    expect(windowList(GT3_WINDOWS).filter((x) => x.key === "tyre_surface_c")).toMatchObject([{ axle: "both", min: 80, max: 100 }]);
    expect(rangeFor(GT3_WINDOWS.tyre_pressure_kpa, "front")).not.toEqual(rangeFor(GT3_WINDOWS.tyre_pressure_kpa, "rear"));
    for (const ws of Object.values(CLASS_WINDOWS)) for (const key of Object.keys(WINDOW_UNITS) as (keyof typeof WINDOW_UNITS)[]) expect(ws[key].tolerance).toBeGreaterThan(0);
  });

  it("covers every car class the fuel table and the mock know", () => {
    for (const cls of [...Object.keys(FUEL_EFFECT_BY_CLASS), "GT3"]) expect(CLASS_WINDOWS[cls]).toBeDefined();
  });
});
