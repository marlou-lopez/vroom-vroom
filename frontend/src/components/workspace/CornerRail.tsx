import type { CompareResponse, TrackMap } from "../../api/types";
import type { Annotation } from "../../lib/annotations";
import { formatDelta } from "../../lib/format";
import { cx } from "../../lib/cx";
import type { CoachState } from "../../state/useCoach";
import styles from "./Workspace.module.css";

/**
 * EXPERIMENTAL (vroom-pnw.30, `?ui=workspace`): every corner in track order with the time it cost or gained (free, from
 * the comparison), and the coach's findings slotted under their corner once Analyze has run. Replaces the Biggest
 * losses row and the Analysis bar's call to action in the prototype.
 */
export interface CornerRailProps {
  cmp: CompareResponse;
  trackMap: TrackMap | null;
  annotations: Annotation[];
  coach: CoachState;
  onSeek(startM: number): void;
}

export function CornerRail({ cmp, trackMap, annotations, coach, onSeek }: CornerRailProps) {
  const self = cmp.lap_id === cmp.ref_lap_id;
  const byId = new Map((trackMap?.corners ?? []).map((c) => [c.id, c]));
  const rows = cmp.corners
    .map((m) => ({ m, c: byId.get(m.corner_id) }))
    .filter((r): r is { m: typeof r.m; c: NonNullable<typeof r.c> } => r.c !== undefined)
    .sort((a, b) => a.c.start_m - b.c.start_m);
  const maxAbs = Math.max(0.05, ...rows.map((r) => Math.abs(r.m.delta_s)));
  const total = cmp.delta[cmp.delta.length - 1] ?? 0;
  const analyzed = Boolean(coach.results.analyze || coach.results.average);
  const busy = coach.running !== null;

  return (
    <aside aria-label="Corners" className={styles.rail}>
      <div className={styles.railHead}>
        <span className={styles.heading}>Where the time goes</span>
        {!self && <span className={cx(styles.total, total > 0.005 && styles.loss, total < -0.005 && styles.gain)}>{formatDelta(total)} s</span>}
      </div>
      <div className={styles.coachBox}>
        {busy ? (
          <span className={styles.muted} role="status">Coach is analyzing…</span>
        ) : analyzed ? (
          <span className={styles.muted}>Coach notes are under their corners.</span>
        ) : (
          <>
            <button type="button" className={styles.coachBtn} disabled={self} onClick={() => void coach.run("analyze")}>
              Ask the coach
            </button>
            <span className={styles.muted}>explains the corners below and gives one thing to fix.</span>
          </>
        )}
        {coach.error && <span role="alert" className={styles.loss}>{coach.error.message}</span>}
      </div>
      {self ? (
        <p className={styles.hint}>Pick a comparison lap to see where you gain and lose time.</p>
      ) : (
        <ul className={styles.cornerList}>
          {rows.map(({ m, c }) => {
            const notes = annotations.filter((a) => a.cornerId === c.id);
            const loss = m.delta_s > 0.005;
            const gain = m.delta_s < -0.005;
            return (
              <li key={c.id} className={styles.cornerRow}>
                <button type="button" className={styles.cornerMain} onClick={() => onSeek(c.start_m)} aria-label={`${c.name}, ${formatDelta(m.delta_s)} seconds. Seek to the corner`}>
                  <span className={styles.cornerName}>{c.name}</span>
                  <span className={styles.bar} aria-hidden="true">
                    <span
                      className={cx(styles.barFill, loss && styles.barLoss, gain && styles.barGain)}
                      style={{ width: `${(Math.abs(m.delta_s) / maxAbs) * 100}%` }}
                    />
                  </span>
                  <span className={cx(styles.cornerDelta, loss && styles.loss, gain && styles.gain)}>{formatDelta(m.delta_s)}</span>
                </button>
                {coach.showNotes && notes.map((a) => (
                  <div key={a.findingId} className={styles.note}>
                    <span className={styles.noteBadge} style={{ background: a.color }}>{a.label}</span>
                    <span>{a.finding.fix}</span>
                  </div>
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
