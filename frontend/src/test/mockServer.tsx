/// <reference types="node" />
// Shared helpers for DOM tests: the MSW mock API over the real Spa recording, and a fresh QueryClient per test.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import type { Api } from "../api/client";
import { createHandlers } from "../api/mock/handlers";
import { createMockApi } from "../api/mock/mockApi";
import type { SpaRecording } from "../api/mock/recording";
import { effectiveValid } from "../api/types";
import { bestValidLap } from "../lib/laps";

const RECORDING = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../public/mock/spa-2026-11-03.json"), "utf8"),
) as SpaRecording;

/**
 * Starts an MSW server for the test file. Every test gets a fresh in-memory engine (so mutations don't leak)
 * and the default handlers; use `server.use(...)` inside a test to force errors.
 */
export function setupMockServer() {
  const server = setupServer();
  const state = { engine: createMockApi({ coachDelayMs: 0, loadSpa: async () => RECORDING }) as Api };
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  beforeEach(() => {
    state.engine = createMockApi({ coachDelayMs: 0, loadSpa: async () => RECORDING });
    server.resetHandlers(...createHandlers(state.engine));
  });
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  return { server, engine: () => state.engine };
}

export function createTestClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

/** A wrapper with a fresh `QueryClient`; returns the client too so tests can inspect the cache. */
export function createQueryWrapper(client = createTestClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

/** The newest session and its best valid flying lap, computed straight from the engine (what the Telemetry page opens by default). */
export async function newestBest(engine: Api) {
  const sessions = [...(await engine.sessions())].sort((a, b) => b.started_at.localeCompare(a.started_at));
  const laps = await engine.sessionLaps(sessions[0].session_id);
  return { session: sessions[0], laps, best: bestValidLap(laps)! };
}

/** Distinct (lap, ref) pairs from the Spa session: valid flying laps that are not the reference, with the reference the engine picks for them. */
export async function spaPairs(engine: Api, count: number) {
  const spa = (await engine.sessions()).find((s) => s.started_at.startsWith("2026-11-03"))!;
  const laps = (await engine.sessionLaps(spa.session_id)).filter((l) => l.kind === "flying" && effectiveValid(l) && l.lap_time_s !== null && !l.is_reference);
  const pairs = await Promise.all(laps.slice(0, count).map(async (l) => ({ lap: l.lap_id, trackId: l.track_id, ref: (await engine.compare(l.lap_id)).ref_lap_id })));
  if (pairs.length < count) throw new Error("recording has too few laps");
  return pairs;
}
