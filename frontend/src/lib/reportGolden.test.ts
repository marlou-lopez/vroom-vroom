/// <reference types="node" />
// The session report's rules exist twice: here (sessionReport.ts, reportWindows.ts) and in the backend (racecoach.report). This test keeps
// one golden file, backend/tests/fixtures/report_golden.json, equal to what these rules produce on the mock recordings, and the backend's
// tests/test_report.py makes the Python rules reproduce it. Change a rule or a window and this fails until the golden is regenerated:
//   UPDATE_REPORT_GOLDEN=1 npx vitest run src/lib/reportGolden.test.ts
// The mock's in-car setting events are left out (settings: null): the backend does not store them, so it reports that category unavailable.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "../api/mock/mockApi";
import { CLASS_WINDOWS, windowList } from "./reportWindows";
import type { ReportInput } from "./sessionReport";

const captured = vi.hoisted(() => [] as unknown[]);
vi.mock("./sessionReport", async (orig) => {
  const m = await orig<typeof import("./sessionReport")>();
  return { ...m, buildSessionReport: (input: ReportInput) => { captured.push(input); return m.buildSessionReport(input); } };
});
const { buildSessionReport } = await import("./sessionReport");

const mock = (n: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../public/mock/${n}`, import.meta.url)), "utf8"));
const GOLDEN = fileURLToPath(new URL("../../../backend/tests/fixtures/report_golden.json", import.meta.url));

async function build() {
  const files = { spa: mock("spa-2026-11-03.json"), monza: mock("monza-2026-11-05.json"), race: mock("spa-race-2026-11-10.json"), raceStint: mock("spa-race-stint-2026-11-10.json"), monzaStint: mock("monza-stint-2026-11-09.json") };
  const api = createMockApi({
    coachDelayMs: 0, loadSpa: async () => files.spa, loadMonza: async () => files.monza, loadSpaRace: async () => files.race,
    loadSpaRaceStint: async () => files.raceStint, loadStint: async () => files.monzaStint,
  });
  captured.length = 0;
  for (const s of await api.sessions()) await api.sessionReport(s.session_id);
  const cases = (captured as ReportInput[]).map((input) => {
    const plain = {
      session_id: input.session_id, car_class: input.car_class, laps: input.laps, stats: input.stats, corners: input.corners,
      traces: [...input.traces].map(([lap_no, t]) => ({ lap_no, ...t })),
      aid_activation: [...input.aid_activation].map(([lap_no, a]) => ({ lap_no, ...a })),
    };
    const report = buildSessionReport({ ...input, settings: null });
    return { input: plain, report: JSON.parse(JSON.stringify(report)) };
  });
  const windows = Object.fromEntries(Object.entries(CLASS_WINDOWS).map(([k, w]) => [k, { compound: w.compound, windows: windowList(w) }]));
  return JSON.parse(JSON.stringify({ windows, cases }));
}

describe("report golden (backend parity)", () => {
  it("matches backend/tests/fixtures/report_golden.json", async () => {
    const now = await build();
    if (process.env.UPDATE_REPORT_GOLDEN) writeFileSync(GOLDEN, `${JSON.stringify(now)}\n`);
    expect(now.cases.length).toBeGreaterThan(0);
    expect(now).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
  }, 60_000);
});
