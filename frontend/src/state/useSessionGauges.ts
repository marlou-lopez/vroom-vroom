import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { idealOptions, segmentTimesOptions } from "../api/queries";
import type { IdealLap, LapWithRef } from "../api/types";
import { lapGauges, type LapGauge } from "../lib/idealGauge";

const NONE = new Map<string, LapGauge>();

/**
 * Each valid flying lap's gap to the session's ideal lap and its segment strip, keyed by lap id (vroom-bi4.2).
 * Empty while loading, or when the session has no valid lap (no ideal lap then).
 */
export function useSessionGauges(sessionId: string | null | undefined, laps: LapWithRef[] | null | undefined) {
  const enabled = !!sessionId;
  const idealQ = useQuery({ ...idealOptions(sessionId ?? ""), enabled });
  const timesQ = useQuery({ ...segmentTimesOptions(sessionId ?? ""), enabled });
  const gauges = useMemo(() => {
    if (!idealQ.data || !timesQ.data || !laps) return NONE;
    const lapTimes = new Map(laps.filter((l) => l.lap_time_s !== null).map((l) => [l.lap_id, l.lap_time_s as number]));
    return lapGauges(idealQ.data, timesQ.data, lapTimes);
  }, [idealQ.data, timesQ.data, laps]);
  const pending = enabled && (idealQ.isPending || timesQ.isPending);
  const error = idealQ.error ?? timesQ.error ?? null;
  return { gauges, ideal: (idealQ.data ?? null) as IdealLap | null, pending, error };
}
