// TanStack Query bindings for the Api: a key factory, typed query hooks and the mutations that keep the cache coherent.
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type {
  CoachRequest, CoachResult, CoachResults, GridChannel, Landmark, LandmarkPatch, LapPatch, TrackMap,
} from "./types";

export const qk = {
  sessions: () => ["sessions"] as const,
  sessionLaps: (sessionId: string) => ["laps", sessionId] as const,
  compare: (lap: string, ref: string | null) => ["compare", lap, ref] as const,
  candidates: (lap: string) => ["candidates", lap] as const,
  trackMap: (trackId: string) => ["trackMap", trackId] as const,
  coachResults: (lap: string, ref: string | null) => ["coachResults", lap, ref] as const,
  summary: (sessionId: string) => ["summary", sessionId] as const,
  trace: (lapId: string, channels: GridChannel[] | undefined) => ["trace", lapId, channels?.join(",") ?? null] as const,
};

// ---- Query options (also used directly where a page runs several queries at once) ----

export const sessionsOptions = () => queryOptions({ queryKey: qk.sessions(), queryFn: () => api.sessions() });
export const sessionLapsOptions = (sessionId: string) =>
  queryOptions({ queryKey: qk.sessionLaps(sessionId), queryFn: () => api.sessionLaps(sessionId) });
export const sessionSummaryOptions = (sessionId: string) =>
  queryOptions({ queryKey: qk.summary(sessionId), queryFn: () => api.sessionSummary(sessionId) });

// ---- Queries ----

export const useSessions = () => useQuery(sessionsOptions());

export const useSessionLaps = (sessionId: string | null) =>
  useQuery({ ...sessionLapsOptions(sessionId ?? ""), enabled: sessionId !== null });

/** A comparison is large and immutable for a (lap, ref) pair; only a lap patch invalidates it. `ref` omitted: the default reference. */
export const useCompare = (lap: string | null, ref?: string | null) =>
  useQuery({
    queryKey: qk.compare(lap ?? "", ref ?? null),
    queryFn: () => api.compare(lap!, ref ?? undefined),
    enabled: lap !== null,
    staleTime: Infinity,
  });

export const useCompareCandidates = (lap: string | null) =>
  useQuery({ queryKey: qk.candidates(lap ?? ""), queryFn: () => api.compareCandidates(lap!), enabled: lap !== null });

export const useTrackMap = (trackId: string | null) =>
  useQuery({ queryKey: qk.trackMap(trackId ?? ""), queryFn: () => api.trackMap(trackId!), enabled: trackId !== null });

/** Stored coach results; only fetched once there is a comparison (`ref`). Writes made for a null `ref` live in the cache only. */
export const useCoachResults = (lap: string | null, ref: string | null) =>
  useQuery({
    queryKey: qk.coachResults(lap ?? "", ref),
    queryFn: () => api.coachResults(lap!, ref!),
    enabled: lap !== null && ref !== null,
  });

export const useSessionSummary = (sessionId: string | null) =>
  useQuery({ ...sessionSummaryOptions(sessionId ?? ""), enabled: sessionId !== null });

export const useLapTrace = (lapId: string | null, channels?: GridChannel[]) =>
  useQuery({ queryKey: qk.trace(lapId ?? "", channels), queryFn: () => api.lapTrace(lapId!, channels), enabled: lapId !== null });

// ---- Mutations ----

/** Pin / validity changes move the default reference, so laps, comparisons and candidates are all refetched. */
export function usePatchLap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lapId, patch }: { lapId: string; patch: LapPatch }) => api.patchLap(lapId, patch),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["laps"] }),
        qc.invalidateQueries({ queryKey: ["compare"] }),
        qc.invalidateQueries({ queryKey: ["candidates"] }),
      ]),
  });
}

/** Runs a coach command. Analyze and Average results are merged into the (lap, ref) cache by command; a corner answer is returned only. */
export function useCoachMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CoachRequest) => api.coach(req),
    onSuccess: (res: CoachResult, req) => {
      if (req.command === "corner") return;
      qc.setQueryData<CoachResults>(qk.coachResults(req.lap_id, req.ref_lap_id), (prev) => ({ ...prev, [req.command]: res }));
    },
  });
}

const withReviewed = (results: CoachResults | undefined, findingId: string, reviewed: boolean): CoachResults | undefined => {
  if (!results) return results;
  const next: CoachResults = {};
  for (const cmd of Object.keys(results) as (keyof CoachResults)[]) {
    const r = results[cmd]!;
    next[cmd] = { ...r, findings: r.findings.map((f) => (f.id === findingId ? { ...f, reviewed } : f)) };
  }
  return next;
};

/** Optimistic: the cache flips at once and is rolled back if the call fails. */
export function useSetFindingReviewed(lap: string | null, ref: string | null) {
  const qc = useQueryClient();
  const key = qk.coachResults(lap ?? "", ref);
  return useMutation({
    mutationFn: ({ findingId, reviewed }: { findingId: string; reviewed: boolean }) => api.setFindingReviewed(findingId, reviewed),
    onMutate: async ({ findingId, reviewed }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<CoachResults>(key);
      qc.setQueryData<CoachResults>(key, (prev) => withReviewed(prev, findingId, reviewed));
      return { previous };
    },
    onError: (_e, _vars, ctx) => qc.setQueryData(key, ctx?.previous),
  });
}

export type LandmarkOp =
  | { op: "add"; landmark: Landmark }
  | { op: "patch"; landmarkId: string; patch: LandmarkPatch }
  | { op: "delete"; landmarkId: string };

/** Add / patch / delete a landmark; the returned map replaces the cached one. */
export function useLandmarkMutation(trackId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (m: LandmarkOp): Promise<TrackMap> => {
      const id = trackId!;
      return m.op === "add" ? api.addLandmark(id, m.landmark)
        : m.op === "patch" ? api.patchLandmark(id, m.landmarkId, m.patch)
        : api.deleteLandmark(id, m.landmarkId);
    },
    onSuccess: (map) => qc.setQueryData(qk.trackMap(map.track_id), map),
  });
}

export function useCalibrate() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (trackId: string) => api.calibrate(trackId), onSuccess: (r) => qc.setQueryData(qk.trackMap(r.map.track_id), r.map) });
}
