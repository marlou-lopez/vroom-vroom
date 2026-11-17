import * as HoverCard from "@radix-ui/react-hover-card";
import { useMemo } from "react";
import { useLap, useSessionSetup } from "../api/queries";
import type { LapWithRef } from "../api/types";
import { diffSetups } from "../lib/setupDiff";
import styles from "./SetupChip.module.css";

export interface SetupChipProps {
  /** The session of the lap being looked at. */
  lapSessionId: string;
  /** The session's laps: a comparison lap found here is in the same session. */
  laps: LapWithRef[];
  /** The lap compared against; null while the comparison loads. */
  refLapId: string | null;
}

/**
 * "Same setup" or "Setup: N changes" (with a hover card listing each one as "Rear wing: 6 → 8", reference → lap).
 * Nothing is shown while loading, when a load fails (not fatal) or when either session has no recorded setup.
 */
export function SetupChip({ lapSessionId, laps, refLapId }: SetupChipProps) {
  const sameSessionRef = refLapId !== null && laps.some((l) => l.lap_id === refLapId);
  // A comparison lap outside this session: fetch it to learn its session.
  const refLap = useLap(refLapId !== null && !sameSessionRef ? refLapId : null).data;
  const refSessionId = refLapId === null ? null : sameSessionRef ? lapSessionId : (refLap?.session_id ?? null);
  const differentSession = refSessionId !== null && refSessionId !== lapSessionId;

  const lapSetup = useSessionSetup(differentSession ? lapSessionId : null).data;
  const refSetup = useSessionSetup(differentSession ? refSessionId : null).data;
  const changes = useMemo(
    () => (lapSetup && refSetup && lapSetup.entries.length && refSetup.entries.length ? diffSetups(refSetup, lapSetup) : null),
    [lapSetup, refSetup],
  );

  if (refSessionId === null) return null;
  if (!differentSession) return <span className={styles.chip}>Same setup</span>;
  if (!changes) return null;
  if (changes.length === 0) return <span className={styles.chip}>Same setup</span>;

  return (
    <HoverCard.Root openDelay={150} closeDelay={100}>
      <HoverCard.Trigger asChild>
        <button type="button" className={styles.chip}>
          Setup: {changes.length} {changes.length === 1 ? "change" : "changes"}
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content align="end" sideOffset={6} collisionPadding={8} className={styles.card}>
          <div className={styles.title}>Reference → this lap</div>
          <ul className={styles.list} aria-label="Setup changes">
            {changes.map((c) => (
              <li key={c.key} className={styles.row}>
                <span className={styles.label}>{c.label}:</span>
                <span className={styles.values}>
                  {c.from ?? "—"} → <span className={styles.to}>{c.to ?? "—"}</span>
                </span>
              </li>
            ))}
          </ul>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
