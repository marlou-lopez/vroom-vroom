import { useMemo, useState } from "react";
import { useQueries, useQuery, type QueryObserverResult } from "@tanstack/react-query";
import { lapOptions, sessionLapsOptions, useCompare, useCompareCandidates, useSessions, useTrackGeometry, useTrackMap } from "../api/queries";
import { ApiError, errorInfo, type CompareCandidate, type LapWithRef, type SessionMeta } from "../api/types";
import { defaultLap } from "../lib/laps";

export interface LapContext {
  session: SessionMeta;
  laps: LapWithRef[];
  lap: LapWithRef;
}

// Module-level so useQueries only re-runs it when the query results change.
function combineLaps(rs: QueryObserverResult<LapWithRef[], Error>[]) {
  return { laps: rs.map((r) => r.data), errors: rs.map((r) => r.error) };
}

const NO_CANDIDATES: CompareCandidate[] = [];

/**
 * Loads what the Telemetry page needs: the lap (and its session's laps), the comparison, the track map and the track geometry.
 * With a `lapParam` it fetches that lap by id, then only its session's laps.
 * With none it opens the newest session's newest valid flying lap that is not the reference (else the best one), against the reference, trying sessions newest first
 * one at a time and stopping at the first that has such a lap.
 */
export function useTelemetryData(lapParam: string | null, refParam: string | null) {
  const sessionsQ = useSessions();
  const sorted = useMemo(
    () => [...(sessionsQ.data ?? [])].sort((a, b) => b.started_at.localeCompare(a.started_at)),
    [sessionsQ.data],
  );
  const lapQ = useQuery({ ...lapOptions(lapParam ?? ""), enabled: lapParam !== null });

  // Sessions whose laps are requested without a lap param: those before `reach` (newest first). It only grows,
  // when a session had no usable lap.
  const [reach, setReach] = useState(1);
  const lapsQ = useQueries({
    queries: sorted.map((s, i) => ({
      ...sessionLapsOptions(s.session_id),
      enabled: lapParam !== null ? s.session_id === lapQ.data?.session_id : i < reach,
    })),
    combine: combineLaps,
  });

  let found: LapContext | null = null;
  let error: unknown = sessionsQ.error;
  let pending = !sessionsQ.data && !error;
  if (lapParam !== null) {
    // Only the lap's own session matters; another session's failure never counts against it.
    if (!error && lapQ.error) error = lapQ.error;
    else if (!error && !lapQ.data) pending = true;
    else if (!error && lapQ.data && sessionsQ.data) {
      const i = sorted.findIndex((s) => s.session_id === lapQ.data.session_id);
      if (i < 0) error = new ApiError("unknown_session", `No session ${lapQ.data.session_id}`);
      else {
        const laps = lapsQ.laps[i];
        const lap = laps?.find((l) => l.lap_id === lapParam);
        if (lapsQ.errors[i] && !laps) error = lapsQ.errors[i];
        else if (!laps) pending = true;
        else if (lap) found = { session: sorted[i], laps, lap };
      }
    }
  } else {
    // Newest first; a session whose /laps failed or has no valid flying lap is skipped (its error is only shown if no
    // session has a lap) and the next one is requested. A session still loading ends the scan.
    let lapsError: unknown = null;
    let next = reach;
    for (let i = 0; !error && !found && i < sorted.length; i++) {
      const laps = lapsQ.laps[i];
      if (!laps && !lapsQ.errors[i]) {
        pending = true;
        break;
      }
      if (!laps) lapsError ??= lapsQ.errors[i];
      else {
        const lap = defaultLap(laps);
        if (lap) {
          found = { session: sorted[i], laps, lap };
          next = Math.max(next, i + 1); // its query must be enabled (active), or a lap patch would not refetch it
          break;
        }
      }
      next = Math.max(next, i + 2);
    }
    if (!found && !pending && !error) error = lapsError;
    if (next > reach && next <= sorted.length) setReach(next);
  }
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
      message: lapParam ? "That lap no longer exists" : "No session with a valid flying lap yet. Import a recording first.",
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
