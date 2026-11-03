// MSW handlers: one per route that realApi calls, each delegating to an in-memory Api engine (createMockApi).
// Paths start with `*/api` so they match with or without an origin (browser worker and node tests alike).
import { http, HttpResponse, type HttpHandler } from "msw";
import type { Api } from "../client";
import { ApiError, type CoachRequest, type GridChannel, type Landmark, type LandmarkPatch, type LapPatch } from "../types";
import { createMockApi } from "./mockApi";

/** 404 for unknown_*, 502 for upstream (LLM) failures, 422 for everything else. */
export function statusFor(code: string): number {
  if (code.startsWith("unknown_")) return 404;
  if (code === "llm_error" || code === "missing_api_key") return 502;
  return 422;
}

export function createHandlers(engine: Api): HttpHandler[] {
  /** Runs one engine call and answers with its JSON, or `{code, message}` and the matching status on an ApiError. */
  const reply = async (call: () => Promise<unknown>) => {
    try {
      return HttpResponse.json((await call()) as object);
    } catch (e) {
      if (e instanceof ApiError) return HttpResponse.json({ code: e.code, message: e.message }, { status: statusFor(e.code) });
      throw e;
    }
  };
  const str = (v: string | readonly string[] | undefined) => String(v);
  const param = (url: string, name: string) => new URL(url).searchParams.get(name) ?? undefined;

  return [
    http.get("*/api/sessions", () => reply(() => engine.sessions())),
    http.get("*/api/sessions/:id/laps", ({ params }) => reply(() => engine.sessionLaps(str(params.id)))),
    http.get("*/api/sessions/:id/summary", ({ params }) => reply(() => engine.sessionSummary(str(params.id)))),
    http.patch("*/api/laps/:id", async ({ params, request }) => {
      const patch = (await request.json()) as LapPatch;
      return reply(() => engine.patchLap(str(params.id), patch));
    }),
    http.get("*/api/laps/:id/trace", ({ params, request }) => {
      const channels = param(request.url, "channels")?.split(",") as GridChannel[] | undefined;
      return reply(() => engine.lapTrace(str(params.id), channels));
    }),
    http.get("*/api/laps/:id/compare-candidates", ({ params }) => reply(() => engine.compareCandidates(str(params.id)))),
    http.get("*/api/compare", ({ request }) => {
      const lap = param(request.url, "lap");
      if (!lap) return HttpResponse.json({ code: "unknown_lap", message: "lap is required" }, { status: 404 });
      return reply(() => engine.compare(lap, param(request.url, "ref")));
    }),
    http.get("*/api/tracks/:id/map", ({ params }) => reply(() => engine.trackMap(str(params.id)))),
    http.post("*/api/tracks/:id/landmarks", async ({ params, request }) => {
      const landmark = (await request.json()) as Landmark;
      return reply(() => engine.addLandmark(str(params.id), landmark));
    }),
    http.patch("*/api/tracks/:id/landmarks/:lid", async ({ params, request }) => {
      const patch = (await request.json()) as LandmarkPatch;
      return reply(() => engine.patchLandmark(str(params.id), str(params.lid), patch));
    }),
    http.delete("*/api/tracks/:id/landmarks/:lid", ({ params }) => reply(() => engine.deleteLandmark(str(params.id), str(params.lid)))),
    http.post("*/api/tracks/:id/calibrate", ({ params }) => reply(() => engine.calibrate(str(params.id)))),
    http.post("*/api/coach", async ({ request }) => {
      const body = (await request.json()) as CoachRequest;
      return reply(() => engine.coach(body));
    }),
    http.get("*/api/coach/results", ({ request }) => {
      const lap = param(request.url, "lap");
      const ref = param(request.url, "ref");
      if (!lap || !ref) return HttpResponse.json({ code: "unknown_lap", message: "lap and ref are required" }, { status: 404 });
      return reply(() => engine.coachResults(lap, ref));
    }),
    http.patch("*/api/coach/findings/:id", async ({ params, request }) => {
      const { reviewed } = (await request.json()) as { reviewed: boolean };
      return reply(() => engine.setFindingReviewed(str(params.id), reviewed));
    }),
    http.post("*/api/import", async ({ request }) => {
      const { path } = (await request.json()) as { path: string };
      return reply(() => engine.importFile(path));
    }),
    http.get("*/api/llm/usage", () => reply(() => engine.llmUsage())),
  ];
}

/** The browser's engine: one in-memory instance, state kept until the page reloads. */
export const handlers = createHandlers(createMockApi());
