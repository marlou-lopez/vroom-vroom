/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Recording } from "../api/mock/recording";
import { createMockApi } from "../api/mock/mockApi";
import { deriveRpmLimits, preUpshiftRpm } from "./shiftLights";

const REC = JSON.parse(readFileSync(fileURLToPath(new URL("../../public/mock/spa-2026-11-03.json", import.meta.url)), "utf8")) as Recording;

describe("rev limit on the Spa laps", async () => {
  const api = createMockApi({ coachDelayMs: 0, loadSpa: async () => REC });
  const s = (await api.sessions()).find((x) => x.started_at.startsWith("2026-11-03"))!;
  const laps = await api.sessionLaps(s.session_id);
  const id = (no: number) => laps.find((l) => l.lap_no === no)!.lap_id;
  const cmp = await api.compare(id(4), id(3));

  it("finds a limit close to the highest rpm of the lap, from the upshifts", () => {
    for (const ch of [cmp.lap, cmp.ref]) {
      const up = preUpshiftRpm(ch.rpm, ch.gear);
      expect(up.length).toBeGreaterThanOrEqual(3);
      const l = deriveRpmLimits(ch.rpm, ch.gear)!;
      const max = Math.max(...ch.rpm);
      expect(l.limit).toBeLessThanOrEqual(max);
      expect(l.limit).toBeGreaterThan(max * 0.9);
      expect(l.limit).toBeGreaterThan(6000);
      expect(l.limit).toBeLessThan(10000);
    }
  });
});
