/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Recording } from "../api/mock/recording";
import { createMockApi } from "../api/mock/mockApi";
import { biggestLosses } from "./biggestLosses";

const REC = JSON.parse(readFileSync(fileURLToPath(new URL("../../public/mock/spa-2026-11-03.json", import.meta.url)), "utf8")) as Recording;

describe("biggest losses on Spa lap 4 against lap 3", async () => {
  const api = createMockApi({ coachDelayMs: 0, loadSpa: async () => REC });
  const s = (await api.sessions()).find((x) => x.started_at.startsWith("2026-11-03"))!;
  const laps = await api.sessionLaps(s.session_id);
  const id = (no: number) => laps.find((l) => l.lap_no === no)!.lap_id;
  const cmp = await api.compare(id(4), id(3));
  const map = await api.trackMap(laps[0].track_id);

  it("lists 3 losses and 1 gain, their times within the lap delta", () => {
    const r = biggestLosses(cmp, map.corners)!;
    const total = cmp.delta[cmp.delta.length - 1];
    expect(r.losses).toHaveLength(3);
    expect(r.gain).not.toBeNull();
    expect(r.losses.every((l) => l.deltaS > 0)).toBe(true);
    expect(r.gain!.deltaS).toBeLessThan(0);
    const sum = r.losses.reduce((a, l) => a + l.deltaS, 0);
    // Lap 4 is faster by 0.436 s here: the listed corners together stay within that gap in size.
    expect(sum + Math.abs(r.gain!.deltaS)).toBeLessThanOrEqual(Math.abs(total));
  });
});
