import { Link, useLocation } from "react-router-dom";
import { lapLink } from "../lib/urlParams";
import { ApiError } from "../api/types";
import { useSessionLaps } from "../api/queries";
import { formatLapTime } from "../lib/format";
import { formatGap } from "../lib/idealGauge";
import { cx } from "../lib/cx";
import { useSessionGauges } from "../state/useSessionGauges";
import { IdealBreakdown } from "./IdealBreakdown";
import { SegmentStrip } from "./SegmentStrip";
import ui from "./ui.module.css";
import styles from "./LapGaugeTable.module.css";

const timesOk = (g: Map<string, unknown>) => g.size > 0;

/** The valid laps of one session, each with its gap to the ideal and to the best lap and a segment strip, beside the ideal lap's breakdown (vroom-bi4.2). */
export function LapGaugeTable({ sessionId }: { sessionId: string }) {
  const { search } = useLocation();
  const lapsQ = useSessionLaps(sessionId);
  const { gauges, ideal, pending, error } = useSessionGauges(sessionId, lapsQ.data);
  const laps = (lapsQ.data ?? []).filter((l) => gauges.has(l.lap_id));

  if (lapsQ.error) return <div className={ui.muted}>{lapsQ.error.message}</div>;
  if (!lapsQ.data) return <div className={ui.muted}>Loading…</div>;
  if (pending) return <div className={ui.muted}>Loading…</div>;
  if (error && (!(error instanceof ApiError) || error.code !== "no_valid_laps")) return <div className={ui.muted}>{error.message}</div>;
  if (!ideal || !timesOk(gauges)) return <section aria-label="Laps against the ideal" className={ui.panel}><div className={ui.muted}>No valid flying lap to build an ideal lap from.</div></section>;

  return (
    <div className={styles.row}>
      <section aria-label="Laps against the ideal" className={cx(ui.panel, styles.laps)}>
        <div className={ui.heading}>LAPS AGAINST THE IDEAL · {formatLapTime(ideal.time_s)}</div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Lap</th>
              <th scope="col" className={styles.num}>Time</th>
              <th scope="col" className={styles.num}>Δ ideal</th>
              <th scope="col" className={styles.num}>Δ best</th>
              <th scope="col">Segments</th>
              <th scope="col"><span className={styles.srOnly}>Open</span></th>
            </tr>
          </thead>
          <tbody>
            {laps.map((l) => {
              const g = gauges.get(l.lap_id)!;
              return (
                <tr key={l.lap_id}>
                  <td className={styles.mono}>L{l.lap_no}</td>
                  <td className={styles.num}>{formatLapTime(g.lapTimeS)}</td>
                  <td className={styles.num}>{formatGap(g.gapToIdealS)}</td>
                  <td className={cx(styles.num, g.gapToBestS === 0 && styles.best)}>{g.gapToBestS === 0 ? "best" : formatGap(g.gapToBestS)}</td>
                  <td><SegmentStrip cells={g.cells} lapId={l.lap_id} label={`L${l.lap_no} segments`} /></td>
                  <td className={styles.open}><Link to={lapLink(search, l.lap_id)} className={styles.openLink} aria-label={`Open lap ${l.lap_no}`}>Open →</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <IdealBreakdown ideal={ideal} />
    </div>
  );
}
