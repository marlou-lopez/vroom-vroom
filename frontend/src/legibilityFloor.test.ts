import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// vroom-pnw.53 / .66: no text under the floor. Outside the stage the floor is 12 px (var(--font-size-small)); the stage (strips,
// transport, wheels, map views and their overlays, and canvas fonts) keeps 11 px (var(--font-size-stage)). A size in SVG user
// units (scaled by a viewBox) may stay below it if its line carries `/* svg-units */`.
const STAGE_FLOOR = 11;
const FLOOR = 12;
const STAGE = /(DetailedStrips|Transport|SimplifiedWheels|AnnotationOverlays|TrackPanel|AnnotationBadges)\.|[\\/]mapviews[\\/]/;
const floorOf = (f: string) => (STAGE.test(f) ? STAGE_FLOOR : FLOOR);

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(css|tsx?)$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

describe("legibility floor", () => {
  it("draws no text under the floor in CSS modules or canvas fonts", () => {
    const bad: string[] = [];
    const re = /(?:font-size\s*:|\bfont\s*:[^;]*?|ctx\.font\s*=\s*`[^`]*?)\b(\d+(?:\.\d+)?)(?:\s*\*\s*dpr\s*\})?px/g;
    for (const f of files("src")) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (line.includes("svg-units") || f.includes("cockpitPaint")) return;
        for (const m of line.matchAll(re)) if (Number(m[1]) < floorOf(f)) bad.push(`${f}:${i + 1}: ${m[0].trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it("sets no inline font size under the floor in components", () => {
    const bad: string[] = [];
    const re = /\bfont-?[sS]ize\s*[=:]\s*\{?\s*["']?(\d+(?:\.\d+)?)(?:px)?["']?/g;
    for (const f of files("src").filter((n) => n.endsWith(".tsx"))) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (line.includes("svg-units") || /fontSize=\{(fontSize|layout)/.test(line)) return;
        for (const m of line.matchAll(re)) if (Number(m[1]) < floorOf(f)) bad.push(`${f}:${i + 1}: ${m[0].trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });
});

describe("stage size", () => {
  it("is used only by stage files", () => {
    const bad = files("src").filter((f) => !STAGE.test(f) && !/(theme\.ts|legibilityFloor\.test\.ts|index\.css)$/.test(f) && /font-size-stage|fontStage/.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
});

describe("tokens", () => {
  it("keeps the stage size under the prose floor and above the stage floor", async () => {
    const { sizes } = await import("./theme");
    expect(sizes.fontStage).toBe(STAGE_FLOOR);
    expect(sizes.fontSmall).toBe(FLOOR);
    expect(sizes.fontBase).toBeGreaterThanOrEqual(sizes.fontSmall);
  });
});
