/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Recording } from "./recording";
import { MIN_SLIP_SPEED_MS, aidRuns, type AidChannels } from "../../lib/driverAids";
import { likelyInvalidRun, offTrackRuns } from "../../lib/offTrack";
import { phaseStart } from "./spaTrack";

const REC = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../public/mock/spa-2026-11-03.json", import.meta.url)), "utf8"),
) as Recording;

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

  // Driver aids and slip (vroom-pnw.14): ABS and TC are in the grid; lap 4 has no lockup, lap 5 has one.
  it("lap 4 has ABS and TC and no lockup or wheelspin marks", () => {
    const lap = REC.laps.find((l) => l.lap_no === 4)!;
    const runs = aidRuns(lap as unknown as AidChannels);
    expect(lap.abs!.length).toBe(lap.t.length);
    expect(runs.abs.length).toBeGreaterThan(5);
    expect(runs.tc.length).toBeGreaterThan(5);
    expect(runs.lockup).toEqual([]);
    expect(runs.wheelspin).toEqual([]);
  });

  it("slip is 1 where the car is below the minimum speed, and the recording lockup shows up", () => {
    for (const lap of REC.laps) {
      for (let i = 0; i < lap.t.length; i++) {
        if (lap.speed_kmh[i] / 3.6 < MIN_SLIP_SPEED_MS) {
          for (const k of ["slip_fl", "slip_fr", "slip_rl", "slip_rr"] as const) expect(lap[k]![i]).toBe(1);
        }
      }
    }
    const lap5 = REC.laps.find((l) => l.lap_no === 5)!;
    expect(aidRuns(lap5 as unknown as AidChannels).lockup.length).toBeGreaterThan(0);
  });
});

describe("wheels_off in the Spa recording (vroom-pnw.24)", () => {
  const wheels = (n: number) => REC.laps.find((l) => l.lap_no === n)!.wheels_off!;
  const runsOf = (n: number) => offTrackRuns({ wheels_off: wheels(n) });

  it("is 0..4 whole wheels on every metre of every lap", () => {
    for (const lap of REC.laps) {
      expect(lap.wheels_off!.length).toBe(lap.t.length);
      for (const v of lap.wheels_off!) expect([0, 1, 2, 3, 4]).toContain(v);
    }
  });
  it("lap 5 (invalid) has marks, with a likely cause", () => {
    expect(runsOf(5).length).toBeGreaterThan(0);
    expect(likelyInvalidRun(runsOf(5))).not.toBeNull();
  });
  it("valid laps 1-4 only have short close-call marks", () => {
    for (const n of [1, 2, 3, 4]) {
      for (const r of runsOf(n)) expect(r.end - r.start + 1).toBeLessThan(100);
    }
    expect(runsOf(2)).toEqual([]);
    // Lap 5 is off the track far more than any valid lap.
    const total = (n: number) => runsOf(n).reduce((s, r) => s + r.end - r.start + 1, 0);
    expect(total(5)).toBeGreaterThan(total(1) + total(3) + total(4));
  });
});
