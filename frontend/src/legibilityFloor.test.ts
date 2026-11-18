import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// vroom-pnw.53: no text under the 11 px floor. Use var(--font-size-small). A size in SVG user units (scaled by a viewBox) may
// stay below it if its line carries `/* svg-units */`.
const FLOOR = 11;

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(css|tsx?)$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

describe("legibility floor", () => {
  it("draws no text under 11 px in CSS modules or canvas fonts", () => {
    const bad: string[] = [];
    const re = /(?:font-size\s*:|\bfont\s*:[^;]*?|ctx\.font\s*=\s*`[^`]*?)\b(\d+(?:\.\d+)?)(?:\s*\*\s*dpr\s*\})?px/g;
    for (const f of files("src")) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (line.includes("svg-units") || f.includes("cockpitPaint")) return;
        for (const m of line.matchAll(re)) if (Number(m[1]) < FLOOR) bad.push(`${f}:${i + 1}: ${m[0].trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it("sets no inline font size under 11 px in components", () => {
    const bad: string[] = [];
    const re = /\bfont-?[sS]ize\s*[=:]\s*\{?\s*["']?(\d+(?:\.\d+)?)(?:px)?["']?/g;
    for (const f of files("src").filter((n) => n.endsWith(".tsx"))) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (line.includes("svg-units") || /fontSize=\{(fontSize|layout)/.test(line)) return;
        for (const m of line.matchAll(re)) if (Number(m[1]) < FLOOR) bad.push(`${f}:${i + 1}: ${m[0].trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
