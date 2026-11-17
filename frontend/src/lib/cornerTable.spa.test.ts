/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Recording } from "../api/mock/recording";
import { createMockApi } from "../api/mock/mockApi";
import { cornerRows, wrapDiff } from "./cornerTable";

const REC = JSON.parse(readFileSync(fileURLToPath(new URL("../../public/mock/spa-2026-11-03.json", import.meta.url)), "utf8")) as Recording;

describe("corner rows on Spa lap 4 against lap 3", async () => {
  const api = createMockApi({ coachDelayMs: 0, loadSpa: async () => REC });
  const s = (await api.sessions()).find((x) => x.started_at.startsWith("2026-11-03"))!;
  const laps = await api.sessionLaps(s.session_id);
  const id = (no: number) => laps.find((l) => l.lap_no === no)!.lap_id;
  const cmp = await api.compare(id(4), id(3));
  const map = await api.trackMap(laps[0].track_id);

  it("has a row for every corner with the comparison's values", () => {
    const rows = cornerRows(cmp.corners, map);
    expect(rows).toHaveLength(map.corners.length);
    expect(rows.map((r) => r.corner.id)).toEqual(map.corners.map((c) => c.id));
    for (const r of rows) {
      const m = cmp.corners.find((c) => c.corner_id === r.corner.id)!;
      expect(r.deltaS).toBe(m.delta_s);
      expect(r.minSpeed.lap).toBe(m.lap.min_speed_kmh);
      expect(r.minSpeed.ref).toBe(m.ref.min_speed_kmh);
      expect(r.exitSpeed.diff).toBeCloseTo(m.lap.exit_speed_kmh - m.ref.exit_speed_kmh, 9);
      expect(r.steer.diff).toBe(m.lap.steer_corrections - m.ref.steer_corrections);
    }
  });
});

describe("wrapDiff", () => {
  it("wraps over the start line", () => {
    expect(wrapDiff(10, 6990, 7000)).toBe(20);
    expect(wrapDiff(6990, 10, 7000)).toBe(-20);
    expect(wrapDiff(100, 90, 7000)).toBe(10);
  });
});
