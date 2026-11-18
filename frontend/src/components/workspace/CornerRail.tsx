import { useState } from "react";
import type { CompareResponse, TrackMap } from "../../api/types";
import type { Annotation } from "../../lib/annotations";
import { cornerRailRows } from "../../lib/cornerRail";
import { cx } from "../../lib/cx";
import { formatDelta } from "../../lib/format";
import type { CoachState } from "../../state/useCoach";
import { loadSetting, saveSetting } from "../mapviews/shared/storage";
import styles from "./Workspace.module.css";

/**
 * "Where the time goes": every corner in track order with the time it cost or gained (free, from the comparison), a
 * direction for the cause, and the coach's findings and "ask about this corner" answers slotted under their corner.
 * The coach entry point stays in the Analysis bar. Collapsible; collapsed by default only in windows narrower than
 * `NARROW_PX`, and a choice made by the user is remembered.
 */
export interface CornerRailProps {
  cmp: CompareResponse;
  trackMap: TrackMap | null;
  /** The findings to show under their corners (empty while the notes are hidden). */
  annotations: Annotation[];
  /** Answers to "ask about this corner", by corner id. */
  deepDives: CoachState["deepDives"];
  /** Seek to the start of the corner. */
  onSeek(startM: number): void;
}

export const CORNER_RAIL_KEY = "vroom.cornerRail";
export const NARROW_PX = 1280;
const STATES = ["open", "collapsed"] as const;

function defaultState(): (typeof STATES)[number] {
  return typeof window !== "undefined" && window.innerWidth < NARROW_PX ? "collapsed" : "open";
}

export function CornerRail({ cmp, trackMap, annotations, deepDives, onSeek }: CornerRailProps) {
  const [state, setState] = useState<(typeof STATES)[number]>(() => loadSetting(CORNER_RAIL_KEY, STATES, defaultState()));
  const [lossesOnly, setLossesOnly] = useState(false);
  const [biggestFirst, setBiggestFirst] = useState(false);
  const toggle = (next: (typeof STATES)[number]) => {
    setState(next);
    saveSetting(CORNER_RAIL_KEY, next);
  };

  if (state === "collapsed") {
    return (
      <aside aria-label="Where the time goes" className={cx(styles.rail, styles.railCollapsed)} data-collapsed="true">
        <button type="button" className={styles.collapseBtn} aria-expanded={false} aria-label="Show the corner list" title="Show the corner list" onClick={() => toggle("open")}>
          ◂
        </button>
        <span className={styles.vertical} aria-hidden="true">Where the time goes</span>
      </aside>
    );
  }

  const self = cmp.lap_id === cmp.ref_lap_id;
  const all = cornerRailRows(cmp, trackMap?.corners ?? []);
  const filtered = lossesOnly ? all.filter((r) => r.kind === "loss") : all;
  // "Biggest first": the biggest loss on top, then the smaller ones, gains last (the most gained at the very end).
  const rows = biggestFirst ? [...filtered].sort((a, b) => b.deltaS - a.deltaS) : filtered;
  const maxAbs = Math.max(0.05, ...all.map((r) => Math.abs(r.deltaS)));
  const total = cmp.delta[cmp.delta.length - 1] ?? 0;

  return (
    <aside aria-label="Where the time goes" className={cx(styles.rail, styles.cornerRail)}>
      <div className={styles.railHead}>
        <span className={styles.heading}>Where the time goes</span>
        <button type="button" className={styles.collapseBtn} aria-expanded aria-label="Hide the corner list" title="Hide the corner list" onClick={() => toggle("collapsed")}>
          ▸
        </button>
      </div>
      {self ? (
        <p className={styles.hint}>Pick a comparison lap to see where you gain and lose time.</p>
      ) : (
        <>
          <div className={styles.railHead}>
            <label className={styles.check}>
              <input type="checkbox" checked={lossesOnly} onChange={(e) => setLossesOnly(e.target.checked)} />
              Losses only
            </label>
            <label className={styles.check}>
              <input type="checkbox" checked={biggestFirst} onChange={(e) => setBiggestFirst(e.target.checked)} />
              Biggest first
            </label>
            <span className={cx(styles.total, total > 0.005 && styles.loss, total < -0.005 && styles.gain)}>{formatDelta(total)} s</span>
          </div>
          {!trackMap ? (
            <p className={styles.muted}>Loading corners…</p>
          ) : rows.length === 0 ? (
            <p className={styles.muted}>{lossesOnly ? "No corner lost time." : "No corners on this track map."}</p>
          ) : (
            <ul className={styles.cornerList}>
              {rows.map(({ corner: c, deltaS, kind, direction }) => {
                const notes = annotations.filter((a) => a.cornerId === c.id);
                const dive = deepDives[c.id];
                return (
                  <li key={c.id} className={styles.cornerRow} data-kind={kind}>
                    <button
                      type="button" className={styles.cornerMain} onClick={() => onSeek(c.start_m)}
                      aria-label={`${c.name}, ${kind === "gain" ? "gained" : kind === "loss" ? "lost" : "even"} ${Math.abs(deltaS).toFixed(3)} seconds${direction ? `, ${direction}` : ""}. Seek to the corner`}
                    >
                      <span className={styles.cornerName}>{c.name}</span>
                      <span className={styles.bar} aria-hidden="true">
                        <span
                          className={cx(styles.barFill, kind === "loss" && styles.barLoss, kind === "gain" && styles.barGain)}
                          style={{ width: `${(Math.abs(deltaS) / maxAbs) * 100}%` }}
                        />
                      </span>
                      <span className={cx(styles.cornerDelta, kind === "loss" && styles.loss, kind === "gain" && styles.gain)}>{formatDelta(deltaS)}</span>
                      {direction && <span className={cx(styles.cause, kind === "gain" && styles.gain)}>{direction}</span>}
                    </button>
                    {notes.map((a) => (
                      <div key={a.findingId} className={styles.note}>
                        <span className={styles.noteBadge} style={{ background: a.color }}>{a.label}</span>
                        <span>{a.finding.fix}</span>
                      </div>
                    ))}
                    {dive && (
                      <div className={styles.note} data-testid="corner-dive">
                        <span>
                          <span className={styles.muted}>About this corner · </span>
                          {dive.what} <span className={styles.muted}>Fix · </span>{dive.fix}
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}
