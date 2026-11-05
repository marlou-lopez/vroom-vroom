/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMockApi } from "../api/mock/mockApi";
import type { SpaRecording } from "../api/mock/recording";
import { buildElevationIndex, elevationProfile, type ElevationTrack } from "./elevation";

const read = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));
const REC = read("../../public/mock/spa-2026-11-03.json") as SpaRecording;
const CAP = read("../../public/mock/spa-elevation-2026-11-05.json") as ElevationTrack;
const idx = buildElevationIndex(CAP);
const FLYING = [1, 2, 3, 4];

// The 3 Nov recording gets heights from the 5 Nov capture, purely through GPS (#94).
describe("Spa elevation attached to the 3 Nov recording", () => {
  it("covers every grid point of the flying laps", () => {
    for (const no of FLYING) {
      const lap = REC.laps.find((l) => l.lap_no === no)!;
      const e = elevationProfile(idx, lap.lat, lap.lon);
      expect(e.filter((v) => v !== null).length / e.length, `lap ${no}`).toBeGreaterThan(0.999);
    }
  });

  it("matches the known Spa figures at Eau Rouge, Raidillon and Kemmel", () => {
    for (const no of FLYING) {
      const lap = REC.laps.find((l) => l.lap_no === no)!;
      const e = elevationProfile(idx, lap.lat, lap.lon) as number[];
      const finite = e.filter((v) => v !== null);
      expect(Math.max(...finite) - Math.min(...finite)).toBeGreaterThan(100); // about 102 m of range
      expect(e[1005]).toBeCloseTo(-1.0, 0); // climbing out of Eau Rouge (the valley floor is about -5 m at 926 m)
      expect(e[1305]).toBeCloseTo(25.4, 0); // Raidillon top
      expect(Math.max(...finite)).toBeCloseTo(74.5, 0); // Kemmel
      expect(e[1305] - e[1005]).toBeGreaterThan(20); // Eau Rouge / Raidillon climb
    }
  });

  it("flying laps agree with each other to well under 0.5 m (measured max 0.24 m)", () => {
    const profiles = FLYING.map((no) => {
      const lap = REC.laps.find((l) => l.lap_no === no)!;
      return elevationProfile(idx, lap.lat, lap.lon) as number[];
    });
    let worst = 0;
    for (let i = 0; i < profiles[0].length; i += 5) {
      const vs = profiles.map((p) => p[i]).filter((v) => v !== undefined);
      worst = Math.max(worst, Math.max(...vs) - Math.min(...vs));
    }
    // Different laps are matched at slightly different spots on a sloping road; stays small.
    expect(worst).toBeLessThan(0.5);
  });

  it("is served through compare for Spa laps and is null for Monza", async () => {
    const api = createMockApi({ coachDelayMs: 0, loadSpa: async () => REC, loadElevation: async () => CAP });
    const sessions = await api.sessions();
    const spa = sessions.find((s) => s.track_id === "spa-francorchamps-grand-prix")!;
    const laps = await api.sessionLaps(spa.session_id);
    const fly = laps.filter((l) => l.kind === "flying" && l.lap_time_s !== null);
    const cmp = await api.compare(fly[0].lap_id, fly[1].lap_id);
    expect(cmp.elevation!.lap).toHaveLength(cmp.distance.length);
    expect(cmp.elevation!.ref).toHaveLength(cmp.distance.length);
    expect(cmp.elevation!.lap[1005]).toBeCloseTo(-1.0, 0);
    const monza = sessions.find((s) => s.track_id === "monza-grand-prix")!;
    const ml = await api.sessionLaps(monza.session_id);
    expect((await api.compare(ml[1].lap_id, ml[0].lap_id)).elevation).toBeNull();
  });

  it("is null without a capture", async () => {
    const api = createMockApi({ coachDelayMs: 0, loadSpa: async () => REC, loadElevation: async () => { throw new Error("offline"); } });
    const spa = (await api.sessions()).find((s) => s.track_id === "spa-francorchamps-grand-prix")!;
    const fly = (await api.sessionLaps(spa.session_id)).filter((l) => l.kind === "flying" && l.lap_time_s !== null);
    expect((await api.compare(fly[0].lap_id, fly[1].lap_id)).elevation).toBeNull();
  });
});
