// Contract test (vroom-9ki.14): the types in `types.ts` and the routes in `client.ts` against the backend's OpenAPI
// schema (`schema.gen.ts`, made by `npm run gen:api`). The type checks run in `tsc -b` (npm run build); the runtime half
// records what the HTTP client really requests and checks each route exists in the schema with that method.
import { describe, expect, expectTypeOf, it } from "vitest";
import type { PathsWithMethod } from "openapi-typescript-helpers";
import { createRealApi } from "./client";
import type { components, paths } from "./schema.gen";
import type {
  CalibrationResult, CarSetup, CoachRequest, CoachResult, CoachResults, CompareCandidate, CompareResponse, Finding, IdealLap,
  ImportResult, LandmarkPatch, LapMeta, LapPatch, LapWithRef, LlmUsage, NewLandmark, SegmentTimes, SessionMeta, SessionReport,
  SessionSummary, Stint, TraceResponse, TrackGeometry, TrackMap,
} from "./types";

type Schemas = components["schemas"];
type Stripped<P extends string> = P extends `/api${infer R}` ? R : P;

describe("request bodies match the backend schema", () => {
  it("what the client sends is accepted by the schema (the schema may be looser)", () => {
    expectTypeOf<CoachRequest>().toExtend<Schemas["CoachRequest"]>();
    expectTypeOf<LapPatch>().toExtend<Schemas["LapPatch"]>();
    expectTypeOf<NewLandmark>().toExtend<Schemas["NewLandmark"]>();
    expectTypeOf<LandmarkPatch>().toExtend<Schemas["LandmarkPatch"]>();
  });
});

// The JSON body of a route's 200 response in the backend's schema.
type Ok<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends {
  responses: { 200: { content: { "application/json": infer B } } };
} ? B : never;

// `true` when a response `A` can be used wherever the client expects `B` (readable errors: see the field in `tsc`'s output).
type Serves<A, B> = [A] extends [never] ? { mismatch: "no 200 JSON response" } : [A] extends [B] ? true : { mismatch: { [K in keyof B]: K extends keyof A ? ([A[K]] extends [B[K]] ? never : K) : K }[keyof B] };

describe("responses match the backend schema (vroom-9ki.21)", () => {
  // What the server's response models promise must be assignable to what `types.ts` says the client gets: a field removed
  // from a model, or a type that no longer fits, fails `tsc` here. (The schema may carry more than the client reads.)
  it("each route's response model satisfies the client's type", () => {
    expectTypeOf<Serves<Ok<"/api/sessions", "get">, SessionMeta[]>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/sessions/{session_id}/laps", "get">, LapWithRef[]>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/laps/{lap_id}", "get">, LapWithRef>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/laps/{lap_id}", "patch">, LapMeta>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/laps/{lap_id}/trace", "get">, TraceResponse>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/compare", "get">, CompareResponse>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/laps/{lap_id}/compare-candidates", "get">, CompareCandidate[]>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/tracks/{track_id}/map", "get">, TrackMap>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/tracks/{track_id}/geometry", "get">, TrackGeometry>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/tracks/{track_id}/landmarks", "post">, TrackMap>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/tracks/{track_id}/landmarks/{landmark_id}", "patch">, TrackMap>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/tracks/{track_id}/landmarks/{landmark_id}", "delete">, TrackMap>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/tracks/{track_id}/calibrate", "post">, CalibrationResult>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/coach", "post">, CoachResult>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/coach/results", "get">, CoachResults>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/coach/findings/{finding_id}", "patch">, Finding>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/sessions/{session_id}/summary", "get">, SessionSummary>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/sessions/{session_id}/setup", "get">, CarSetup>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/sessions/{session_id}/ideal", "get">, IdealLap>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/sessions/{session_id}/segment-times", "get">, SegmentTimes>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/sessions/{session_id}/stints", "get">, Stint[]>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/sessions/{session_id}/report", "get">, SessionReport>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/import", "post">, ImportResult>>().toEqualTypeOf<true>();
    expectTypeOf<Serves<Ok<"/api/llm/usage", "get">, LlmUsage>>().toEqualTypeOf<true>();
  });
});

describe("every route the client calls exists in the schema", () => {
  // The server's path templates, by method, without the `/api` prefix (checked as types: a typo fails `tsc`).
  const get = (p: Stripped<PathsWithMethod<paths, "get">>) => p;
  const post = (p: Stripped<PathsWithMethod<paths, "post">>) => p;
  const patch = (p: Stripped<PathsWithMethod<paths, "patch">>) => p;
  const del = (p: Stripped<PathsWithMethod<paths, "delete">>) => p;

  it("records each Api method's request and finds it in the schema", async () => {
    const calls: { method: string; url: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(input) });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const api = createRealApi("http://x");
      await Promise.all([
        api.sessions(), api.sessionLaps("s"), api.lap("l"), api.patchLap("l", {}), api.lapTrace("l"), api.compare("l", "r"),
        api.compareCandidates("l"), api.trackMap("t"), api.trackGeometry("t"),
        api.addLandmark("t", { label: "a", kind: "custom", distance_m: 1, corner_id: null }), api.patchLandmark("t", "m", {}),
        api.deleteLandmark("t", "m"), api.coach({ command: "analyze", lap_id: "l", ref_lap_id: null, corner_id: null }), api.coachResults("l", "r"),
        api.setFindingReviewed("f", true), api.sessionSummary("s"), api.sessionSetup("s"), api.idealLap("s"),
        api.segmentTimes("s"), api.calibrate("t"), api.importFile("p"), api.llmUsage(), api.sessionStints("s"),
        api.sessionReport("s"),
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }

    // Typed table: the template each Api method is meant to hit.
    const expected: [string, string][] = [
      ["GET", get("/sessions")], ["GET", get("/sessions/{session_id}/laps")], ["GET", get("/laps/{lap_id}")],
      ["PATCH", patch("/laps/{lap_id}")], ["GET", get("/laps/{lap_id}/trace")], ["GET", get("/compare")],
      ["GET", get("/laps/{lap_id}/compare-candidates")], ["GET", get("/tracks/{track_id}/map")],
      ["GET", get("/tracks/{track_id}/geometry")], ["POST", post("/tracks/{track_id}/landmarks")],
      ["PATCH", patch("/tracks/{track_id}/landmarks/{landmark_id}")], ["DELETE", del("/tracks/{track_id}/landmarks/{landmark_id}")],
      ["POST", post("/coach")], ["GET", get("/coach/results")], ["PATCH", patch("/coach/findings/{finding_id}")],
      ["GET", get("/sessions/{session_id}/summary")], ["GET", get("/sessions/{session_id}/setup")],
      ["GET", get("/sessions/{session_id}/ideal")], ["GET", get("/sessions/{session_id}/segment-times")],
      ["POST", post("/tracks/{track_id}/calibrate")], ["POST", post("/import")], ["GET", get("/llm/usage")],
      ["GET", get("/sessions/{session_id}/stints")], ["GET", get("/sessions/{session_id}/report")],
    ];
    expect(calls).toHaveLength(expected.length);
    const toRegex = (tpl: string) => new RegExp(`^http://x/api${tpl.replace(/\{[^}]+\}/g, "[^/?]+")}(\\?.*)?$`);
    for (const [method, tpl] of expected) {
      expect(calls.some((c) => c.method === method && toRegex(tpl).test(c.url)), `${method} ${tpl}`).toBe(true);
    }
    // No two templates collapse to one call: each Api method made its own request.
    for (const c of calls) {
      const hits = expected.filter(([m, t]) => m === c.method && toRegex(t).test(c.url));
      expect(hits.length, `${c.method} ${c.url}`).toBeGreaterThan(0);
    }
  });
});
