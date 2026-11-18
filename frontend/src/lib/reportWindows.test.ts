/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLASS_WINDOWS, WINDOW_UNITS } from "./reportWindows";
import { FUEL_EFFECT_BY_CLASS } from "../api/mock/stint";

const doc = readFileSync(fileURLToPath(new URL("../../../docs/session-report/windows.md", import.meta.url)), "utf8");
const rows = doc.split("\n").filter((l) => /^\| (GT3|Hypercar|LMP2) /.test(l)).map((l) => l.split("|").map((c) => c.trim()));

describe("report windows", () => {
  it("docs/session-report/windows.md lists every value of the code's table, with a source", () => {
    const keys = Object.keys(WINDOW_UNITS);
    expect(rows.length).toBe(Object.keys(CLASS_WINDOWS).length * keys.length);
    for (const [cls, ws] of Object.entries(CLASS_WINDOWS)) {
      for (const key of keys as (keyof typeof WINDOW_UNITS)[]) {
        const row = rows.find((c) => c[1] === cls && c[3] === key);
        expect(row, `${cls} ${key}`).toBeDefined();
        expect([row![2], Number(row![4]), Number(row![5]), row![6]]).toEqual([ws.compound, ws[key].min, ws[key].max, WINDOW_UNITS[key]]);
        expect(row![7].length).toBeGreaterThan(0);
        expect(ws[key].source.length).toBeGreaterThan(0);
      }
    }
  });

  it("covers every car class the fuel table and the mock know", () => {
    for (const cls of [...Object.keys(FUEL_EFFECT_BY_CLASS), "GT3"]) expect(CLASS_WINDOWS[cls]).toBeDefined();
  });
});
