import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutationState, useQueryClient } from "@tanstack/react-query";
import { useCoachMutation, useCoachResults, useSetFindingReviewed } from "../api/queries";
import { errorInfo, type CoachResults, type Finding } from "../api/types";

export interface CoachError {
  code: string;
  message: string;
}

const NO_RESULTS: CoachResults = {};

/**
 * Coach state for one (lap, comparison) pair: the stored results (cached per pair, so earlier annotations
 * come back without an LLM call), running/error state, notes visibility and per-corner deep dives.
 * `refLapId` may be null (comparison failed): Analyze/Average can still be tried and report their error inline.
 */
export function useCoach(lapId: string | null, refLapId: string | null) {
  const scope = `${lapId}|${refLapId}`;
  const [showNotes, setShowNotes] = useState(true);
  const [dives, setDives] = useState<Record<string, Finding>>({});
  const resultsQ = useCoachResults(lapId, refLapId);
  const queryClient = useQueryClient();
  const runKey = useMemo(() => ["coach", "run", lapId, refLapId] as const, [lapId, refLapId]);
  const runM = useCoachMutation({ mutationKey: runKey, onSuccess: () => setShowNotes(true) });
  const cornerM = useCoachMutation();
  const reviewM = useSetFindingReviewed(lapId, refLapId);
  const { reset: resetRun, mutate: startRun } = runM;
  const { mutateAsync: askCornerAsync } = cornerM;
  const { reset: resetReview } = reviewM;
  const pendingRuns = useMutationState({
    filters: { mutationKey: runKey, exact: true, status: "pending" },
    select: (mutation) => {
      const value = mutation.state.variables;
      return typeof value === "object" && value !== null && "command" in value &&
        (value.command === "analyze" || value.command === "average") ? value.command : null;
    },
  });
  const running = pendingRuns.find((command) => command !== null) ?? null;

  // A new (lap, comparison) pair starts without the previous pair's error.
  useEffect(() => {
    resetRun();
    resetReview();
  }, [scope, resetRun, resetReview]);

  const run = useCallback(
    (command: "analyze" | "average") => {
      if (!lapId || queryClient.isMutating({ mutationKey: runKey, exact: true })) return;
      startRun({ command, lap_id: lapId, ref_lap_id: refLapId, corner_id: null });
    },
    [lapId, refLapId, queryClient, runKey, startRun],
  );

  /** Ask about one corner. Resolves with the returned finding; rejects with the API error. */
  const askCorner = useCallback(
    async (cornerId: string): Promise<Finding> => {
      if (!lapId) throw new Error("no lap");
      const res = await askCornerAsync({ command: "corner", lap_id: lapId, ref_lap_id: refLapId, corner_id: cornerId });
      const finding = res.findings[0];
      if (!finding) throw new Error("The coach returned no finding for this corner.");
      setDives((p) => ({ ...p, [`${scope}|${cornerId}`]: finding }));
      return finding;
    },
    [lapId, refLapId, scope, askCornerAsync],
  );

  const deepDives = useMemo(() => {
    const prefix = `${scope}|`;
    return Object.fromEntries(Object.entries(dives).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
  }, [dives, scope]);

  const setReviewed = reviewM.mutate;
  const failure = runM.error ?? reviewM.error ?? resultsQ.error;
  const error: CoachError | null = failure ? errorInfo(failure) : null;

  return {
    results: resultsQ.data ?? NO_RESULTS,
    running,
    error,
    showNotes,
    setShowNotes,
    deepDives,
    run,
    askCorner,
    setReviewed: useCallback((findingId: string, reviewed: boolean) => setReviewed({ findingId, reviewed }), [setReviewed]),
  };
}

export type CoachState = ReturnType<typeof useCoach>;
