import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { sessionLapsOptions, useCompare, useCompareCandidates, useSessions, useTrackGeometry, useTrackMap } from "../api/queries";
import { errorInfo, type CompareCandidate, type LapWithRef, type SessionMeta } from "../api/types";
import { bestValidLap } from "../lib/laps";

export interface LapContext {
  session: SessionMeta;
  laps: LapWithRef[];
  lap: LapWithRef;
}

const NO_CANDIDATES: CompareCandidate[] = [];

/**
 * Loads what the Telemetry page needs: the lap (and its session's laps), the comparison, the track map and the track geometry.
 * With no `lapParam` it opens the newest session's best valid flying lap against its reference.
 * Note: the API has no "get lap by id", so a lap is found by scanning sessions newest first.
 */
export function useTelemetryData(lapParam: string | null, refParam: string | null) {
  const sessionsQ = useSessions();
  const sorted = useMemo(
    () => [...(sessionsQ.data ?? [])].sort((a, b) => b.started_at.localeCompare(a.started_at)),
    [sessionsQ.data],
  );
  // Laps of every session, in parallel and cached (the Sessions page shares them); the scan below still goes newest first.
  const lapsQ = useQueries({
    queries: sorted.map((s) => sessionLapsOptions(s.session_id)),
    combine: (rs) => ({ laps: rs.map((r) => r.data), errors: rs.map((r) => r.error) }),
  });

  // Scan newest first; stop at the first session that is still loading. A session whose own /laps failed is skipped
  // (its error is only shown if no other session has the lap); another session's error never counts for this one.
  let found: LapContext | null = null;
  let error: unknown = sessionsQ.error;
  let pending = !sessionsQ.data && !error;
  let lapsError: unknown = null;
  for (let i = 0; !error && !found && i < sorted.length; i++) {
    const laps = lapsQ.laps[i];
    if (!laps) {
      if (lapsQ.errors[i]) {
        lapsError ??= lapsQ.errors[i];
        continue;
      }
      pending = true;
      break;
    }
    const lap = lapParam ? laps.find((l) => l.lap_id === lapParam) : bestValidLap(laps);
    if (lap) found = { session: sorted[i], laps, lap };
  }
  if (!found && !pending && !error) error = lapsError;
  // Keep the context's identity while its parts are unchanged (an effect on the page depends on it).
  const ctx = useMemo(() => found, [found?.session, found?.laps, found?.lap]); // oxlint-disable-line react-hooks/exhaustive-deps

  const lapId = ctx?.lap.lap_id ?? null;
  const cmpQ = useCompare(lapId, refParam);
  const candidatesQ = useCompareCandidates(lapId);
  const trackMapQ = useTrackMap(ctx?.lap.track_id ?? null); // not fatal if it is missing
  const geometryQ = useTrackGeometry(ctx?.lap.track_id ?? null); // keyed by track, so a new reference lap does not refetch it; not fatal either

  let shown: { code: string; message: string } | null = null;
  if (error) shown = errorInfo(error);
  else if (!ctx && !pending) {
    shown = {
      code: lapParam ? "unknown_lap" : "no_laps",
      message: lapParam ? `No lap ${lapParam}` : "No session with a valid flying lap yet. Import a recording first.",
    };
  } else if (cmpQ.error) shown = errorInfo(cmpQ.error);

  return {
    ctx,
    cmp: cmpQ.data ?? null,
    candidates: candidatesQ.data ?? NO_CANDIDATES,
    trackMap: trackMapQ.data ?? null,
    geometry: geometryQ.data ?? null,
    error: shown,
  };
}
