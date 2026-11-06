import {
  ApiError,
  type CalibrationResult, type CoachRequest, type CoachResult, type CoachResults, type CompareCandidate,
  type CompareResponse, type Finding, type GridChannel, type ImportResult, type Landmark, type LandmarkPatch,
  type LapMeta, type LapPatch, type LapWithRef, type LlmUsage, type SessionMeta, type SessionSummary,
  type TraceResponse, type TrackGeometry, type TrackMap,
} from "./types";

/** The only way components talk to the backend. One method per route. */
export interface Api {
  sessions(): Promise<SessionMeta[]>;
  sessionLaps(sessionId: string): Promise<LapWithRef[]>;
  patchLap(lapId: string, patch: LapPatch): Promise<LapMeta>;
  lapTrace(lapId: string, channels?: GridChannel[]): Promise<TraceResponse>;
  /** `ref` omitted: the reference for the lap's track and car is used. */
  compare(lap: string, ref?: string): Promise<CompareResponse>;
  compareCandidates(lapId: string): Promise<CompareCandidate[]>;
  trackMap(trackId: string): Promise<TrackMap>;
  /** Centreline, elevation, edges, kerbs and the coordinate transform of a track, computed once per track. */
  trackGeometry(trackId: string): Promise<TrackGeometry>;
  addLandmark(trackId: string, landmark: Landmark): Promise<TrackMap>;
  patchLandmark(trackId: string, landmarkId: string, patch: LandmarkPatch): Promise<TrackMap>;
  deleteLandmark(trackId: string, landmarkId: string): Promise<TrackMap>;
  coach(req: CoachRequest): Promise<CoachResult>;
  coachResults(lap: string, ref: string): Promise<CoachResults>;
  setFindingReviewed(findingId: string, reviewed: boolean): Promise<Finding>;
  sessionSummary(sessionId: string): Promise<SessionSummary>;
  calibrate(trackId: string): Promise<CalibrationResult>;
  importFile(path: string): Promise<ImportResult>;
  llmUsage(): Promise<LlmUsage>;
}

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

async function errorFrom(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = res.statusText || code;
  try {
    const body = await res.json();
    // Accept both `{code, message}` and FastAPI's `{detail: {code, message}}` / `{detail: "text"}`.
    const b = body?.detail && typeof body.detail === "object" ? body.detail : body;
    if (typeof b?.code === "string") code = b.code;
    if (typeof b?.message === "string") message = b.message;
    else if (typeof body?.detail === "string") message = body.detail;
  } catch {
    /* non-JSON error body: keep the HTTP status text */
  }
  return new ApiError(code, message);
}

async function send<T>(baseUrl: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api${path}`, {
      method: init?.method ?? "GET",
      headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (e) {
    throw new ApiError("network", e instanceof Error ? e.message : "network error");
  }
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

/** The HTTP implementation. `baseUrl` (default: same origin) is only needed where relative URLs do not resolve, e.g. node tests. */
export function createRealApi(baseUrl = ""): Api {
  const request = <T>(path: string, init?: { method?: string; body?: unknown }) => send<T>(baseUrl, path, init);
  return {
    sessions: () => request("/sessions"),
    sessionLaps: (id) => request(`/sessions/${enc(id)}/laps`),
    patchLap: (id, patch) => request(`/laps/${enc(id)}`, { method: "PATCH", body: patch }),
    lapTrace: (id, channels) =>
      request(`/laps/${enc(id)}/trace${query({ channels: channels?.length ? channels.join(",") : undefined })}`),
    compare: (lap, ref) => request(`/compare${query({ lap, ref })}`),
    compareCandidates: (lap) => request(`/laps/${enc(lap)}/compare-candidates`),
    trackMap: (trackId) => request(`/tracks/${enc(trackId)}/map`),
    trackGeometry: (trackId) => request(`/tracks/${enc(trackId)}/geometry`),
    addLandmark: (trackId, lm) => request(`/tracks/${enc(trackId)}/landmarks`, { method: "POST", body: lm }),
    patchLandmark: (trackId, id, patch) =>
      request(`/tracks/${enc(trackId)}/landmarks/${enc(id)}`, { method: "PATCH", body: patch }),
    deleteLandmark: (trackId, id) => request(`/tracks/${enc(trackId)}/landmarks/${enc(id)}`, { method: "DELETE" }),
    coach: (req) => request("/coach", { method: "POST", body: req }),
    coachResults: (lap, ref) => request(`/coach/results${query({ lap, ref })}`),
    setFindingReviewed: (id, reviewed) =>
      request(`/coach/findings/${enc(id)}`, { method: "PATCH", body: { reviewed } }),
    sessionSummary: (id) => request(`/sessions/${enc(id)}/summary`),
    calibrate: (trackId) => request(`/tracks/${enc(trackId)}/calibrate`, { method: "POST" }),
    importFile: (path) => request("/import", { method: "POST", body: { path } }),
    llmUsage: () => request("/llm/usage"),
  };
}

export const realApi: Api = createRealApi();
/** Always the HTTP client. With VITE_API=mock a service worker (MSW) answers the requests instead. */
export const api: Api = realApi;
