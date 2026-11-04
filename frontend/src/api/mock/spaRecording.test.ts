/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SpaRecording } from "./recording";
import { phaseStart } from "./spaTrack";

const REC = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../public/mock/spa-2026-11-03.json", import.meta.url)), "utf8"),
) as SpaRecording;

describe("Spa recording mock data", () => {
  // LMU's filtered 'Throttle Pos' drops to 0 at every upshift (the game's ignition cut); the pedal channel does not (#49).
  // The cut lasts ~0.1-0.3 s, i.e. a few metres either side of the shift; a real lift for a corner comes later.
  it("throttle is the driver's pedal: no dip at upshifts made flat out (flying laps)", () => {
    let flatUpshifts = 0;
    for (const lap of REC.laps.filter((l) => l.lap_no >= 1 && l.lap_no <= 4)) {
      for (let i = 5; i < lap.gear.length - 5; i++) {
        if (!(lap.gear[i] > lap.gear[i - 1] && lap.gear[i - 1] > 0) || lap.throttle[i - 5] < 0.95) continue;
        flatUpshifts++;
        const around = lap.throttle.slice(i - 5, i + 6);
        expect(Math.min(...around), `lap ${lap.lap_no}, upshift at ${i} m`).toBeGreaterThanOrEqual(0.95);
      }
    }
    expect(flatUpshifts).toBeGreaterThan(60); // 18 upshifts per flying lap at Spa, nearly all flat out
  });

  it("phaseStart ignores a brief full-throttle stab inside a braking phase (Bus Stop chicane)", () => {
    // Flat to 100 m, braking 100-170, a 5 m throttle stab at 170-174, then part throttle to the apex at 200.
    const n = 201;
    const throttle = Array.from({ length: n }, (_, i) => (i < 100 || (i >= 170 && i < 175) ? 1 : 0.2));
    const brake = Array.from({ length: n }, (_, i) => (i >= 100 && i < 170 ? 1 : 0));
    expect(phaseStart({ throttle, brake }, 200, 0)).toBe(99);
    // A real flat-out stretch of 20 m or more still counts.
    const throttle2 = throttle.map((v, i) => (i >= 150 && i < 175 ? 1 : v));
    const brake2 = brake.map((v, i) => (i >= 150 && i < 175 ? 0 : v));
    expect(phaseStart({ throttle: throttle2, brake: brake2 }, 200, 0)).toBe(174);
  });
});
