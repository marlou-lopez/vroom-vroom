/// <reference types="node" />
// realApi end to end: real fetch calls answered by the MSW handlers, which delegate to the in-memory engine.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRealApi } from "./client";
import { createHandlers } from "./mock/handlers";
import { createMockApi } from "./mock/mockApi";
import type { Recording } from "./mock/recording";
import { ApiError } from "./types";

const RECORDING = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../public/mock/spa-2026-11-03.json", import.meta.url)), "utf8"),
) as Recording;

const MONZA = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../public/mock/monza-2026-11-05.json", import.meta.url)), "utf8"),
) as Recording;

const server = setupServer(...createHandlers(createMockApi({ coachDelayMs: 0, loadSpa: async () => RECORDING, loadMonza: async () => MONZA })));
const api = createRealApi("http://localhost");

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected rejection");
}

describe("realApi over MSW", () => {
  it("lists sessions and laps", async () => {
    const sessions = await api.sessions();
    expect(sessions.length).toBeGreaterThan(1);
    const laps = await api.sessionLaps(sessions[0].session_id);
    expect(laps.length).toBeGreaterThan(0);
  });

  it("fetches track geometry, and 404s for an unknown track", async () => {
    const g = await api.trackGeometry("spa-francorchamps-grand-prix");
    expect(g.track_id).toBe("spa-francorchamps-grand-prix");
    expect(g.centre.lat.length).toBeGreaterThan(1000);
    expect((await rejection(api.trackGeometry("nope"))).code).toBe("unknown_track");
  });

  it("compares a lap with its reference", async () => {
    const sessions = await api.sessions();
    const spa = sessions.find((s) => s.started_at.startsWith("2026-11-03"))!;
    const laps = await api.sessionLaps(spa.session_id);
    const lap = laps.find((l) => l.kind === "flying" && l.lap_time_s !== null && !l.is_reference)!;
    const cmp = await api.compare(lap.lap_id);
    expect(cmp.lap_id).toBe(lap.lap_id);
    expect(cmp.delta.length).toBeGreaterThan(0);
  });

  it("keeps the status and code of a track_mismatch (422)", async () => {
    const sessions = await api.sessions();
    const all = await Promise.all(sessions.map(async (s) => ({ s, laps: await api.sessionLaps(s.session_id) })));
    const a = all.find((x) => x.s.track_id.startsWith("spa"))!.laps.find((l) => l.kind === "flying")!;
    const b = all.find((x) => x.s.track_id.startsWith("monza"))!.laps.find((l) => l.kind === "flying")!;
    const res = await fetch(`http://localhost/api/compare?lap=${a.lap_id}&ref=${b.lap_id}`);
    expect(res.status).toBe(422);
    const err = await rejection(api.compare(a.lap_id, b.lap_id));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("track_mismatch");
  });

  it("answers unknown ids with 404 and the code", async () => {
    const res = await fetch("http://localhost/api/sessions/nope/laps");
    expect(res.status).toBe(404);
    expect((await rejection(api.sessionLaps("nope"))).code).toBe("unknown_session");
  });

  it("runs coach analyze, stores it and persists a reviewed flag", async () => {
    const sessions = await api.sessions();
    const spa = sessions.find((s) => s.started_at.startsWith("2026-11-03"))!;
    const laps = await api.sessionLaps(spa.session_id);
    const lap = laps.find((l) => l.kind === "flying" && l.lap_time_s !== null && !l.is_reference)!;
    const cmp = await api.compare(lap.lap_id);
    const res = await api.coach({ command: "analyze", lap_id: lap.lap_id, ref_lap_id: cmp.ref_lap_id, corner_id: null });
    expect(res.command).toBe("analyze");
    expect(res.findings.length).toBeGreaterThan(0);
    expect((await api.coachResults(lap.lap_id, cmp.ref_lap_id)).analyze?.findings.length).toBe(res.findings.length);

    const finding = res.findings[0];
    const updated = await api.setFindingReviewed(finding.id, true);
    expect(updated.reviewed).toBe(true);
    const again = (await api.coachResults(lap.lap_id, cmp.ref_lap_id)).analyze!.findings.find((f) => f.id === finding.id)!;
    expect(again.reviewed).toBe(true);
  });
});
