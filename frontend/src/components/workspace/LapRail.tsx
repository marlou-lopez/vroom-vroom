import { useState } from "react";
import { effectiveValid, type CompareCandidate, type LapWithRef } from "../../api/types";
import { formatLapTime } from "../../lib/format";
import { formatGap } from "../../lib/idealGauge";
import { cx } from "../../lib/cx";
import styles from "./Workspace.module.css";

/**
 * EXPERIMENTAL (vroom-pnw.30, `?ui=workspace`): the session's laps as an always-visible list, MoTeC / Garage 61 style.
 * Click a row to study that lap; the "ref" button on a row makes it the comparison. Quick picks above the list cover the
 * comparisons that are not laps of this session (the track reference, the ideal lap).
 */
export interface LapRailProps {
  laps: LapWithRef[];
  lapId: string;
  refLapId: string | null;
  candidates: CompareCandidate[];
  onSelectLap(lapId: string): void;
  /** `null` selects the track/car reference. */
  onSelectRef(lapId: string | null): void;
}

export function LapRail({ laps, lapId, refLapId, candidates, onSelectLap, onSelectRef }: LapRailProps) {
  const [validOnly, setValidOnly] = useState(true);
  const timed = laps.filter((l) => l.kind === "flying" && effectiveValid(l) && l.lap_time_s !== null);
  const best = timed.length ? Math.min(...timed.map((l) => l.lap_time_s!)) : null;
  // The studied lap and the comparison stay listed even when the filter would hide them (an in-lap picked from a deep link).
  const shown = laps.filter((l) => !validOnly || (l.kind === "flying" && effectiveValid(l)) || l.lap_id === lapId || l.lap_id === refLapId);
  const candidateIds = new Set(candidates.map((c) => c.lap_id));
  const ideal = candidates.find((c) => c.is_ideal) ?? null;
  const reference = candidates.find((c) => c.is_reference) ?? null;
  const self = lapId === refLapId;

  return (
    <aside aria-label="Laps" className={styles.rail}>
      <div className={styles.railHead}>
        <span className={styles.heading}>Laps</span>
        <label className={styles.check}>
          <input type="checkbox" checked={validOnly} onChange={(e) => setValidOnly(e.target.checked)} /> valid only
        </label>
      </div>
      {self && (
        <p className={styles.hint} role="status">
          This lap is its own reference, so there is nothing to compare. Pick another lap, or compare with the ideal lap.
        </p>
      )}
      <div className={styles.quick} role="group" aria-label="Compare with">
        <span className={styles.muted}>Compare with</span>
        <button type="button" className={styles.quickBtn} aria-pressed={reference !== null && refLapId === reference.lap_id} onClick={() => onSelectRef(null)}>
          ★ Reference
        </button>
        {ideal && (
          <button type="button" className={cx(styles.quickBtn, styles.idealBtn)} aria-pressed={refLapId === ideal.lap_id} onClick={() => onSelectRef(ideal.lap_id)}>
            Ideal {ideal.lap_time_s === null ? "" : formatLapTime(ideal.lap_time_s)}
          </button>
        )}
      </div>
      <ul className={styles.lapList}>
        {shown.map((l) => {
          const isYou = l.lap_id === lapId;
          const isRef = l.lap_id === refLapId;
          const gap = best !== null && l.lap_time_s !== null && l.kind === "flying" && effectiveValid(l) ? l.lap_time_s - best : null;
          return (
            <li key={l.lap_id} className={styles.lapRow} data-you={isYou || undefined} data-ref={isRef || undefined}>
              <button type="button" className={styles.lapMain} aria-current={isYou || undefined} onClick={() => onSelectLap(l.lap_id)}>
                <span className={styles.lapMarker} aria-hidden="true">{isYou ? "●" : isRef ? "○" : ""}</span>
                <span className={styles.lapNo}>L{l.lap_no}</span>
                <span className={styles.lapTime}>{l.lap_time_s === null ? "—" : formatLapTime(l.lap_time_s)}</span>
                <span className={styles.lapGap}>
                  {l.kind !== "flying" ? l.kind.toUpperCase() : !effectiveValid(l) ? "invalid" : gap === 0 ? "best" : gap === null ? "" : formatGap(gap)}
                  {l.is_reference && <span title="Reference for this track and car"> ★</span>}
                </span>
              </button>
              {!isYou && candidateIds.has(l.lap_id) && (
                <button
                  type="button" className={styles.refBtn} aria-pressed={isRef}
                  aria-label={`Compare with L${l.lap_no}`} title="Use as the comparison lap"
                  onClick={() => onSelectRef(l.lap_id)}
                >
                  ref
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className={styles.legend}>
        <span className={styles.you}>●</span> you · <span className={styles.ref}>○</span> comparison. Click a lap to study it.
      </p>
    </aside>
  );
}
