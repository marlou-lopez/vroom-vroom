import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { lapLink } from "../lib/urlParams";
import { ApiError } from "../api/types";
import { LAP_KIND_TEXT, lapTag } from "../lib/laps";
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

/**
 * Every lap of one session, tagged flying, out, in or invalid; valid flying laps carry their gap to the ideal and to the best lap
 * and a segment strip, beside the ideal lap's breakdown (vroom-bi4.2). Any lap with a trace opens in Telemetry; a lap without one
 * is "stats only" and does not link (vroom-x19). "valid only" hides everything but valid flying laps, as the Telemetry lap rail does.
 */
export function LapGaugeTable({ sessionId }: { sessionId: string }) {
  const { search } = useLocation();
  const [validOnly, setValidOnly] = useState(false);
  const lapsQ = useSessionLaps(sessionId);
  const { gauges, ideal, pending, error } = useSessionGauges(sessionId, lapsQ.data);
  const laps = (lapsQ.data ?? []).filter((l) => !validOnly || lapTag(l) === "flying");

  if (lapsQ.error) return <div className={ui.muted}>{lapsQ.error.message}</div>;
  if (!lapsQ.data) return <div className={ui.muted}>Loading…</div>;
  if (pending) return <div className={ui.muted}>Loading…</div>;
  if (error && (!(error instanceof ApiError) || error.code !== "no_valid_laps")) return <div className={ui.muted}>{error.message}</div>;
  const hasIdeal = !!ideal && timesOk(gauges);

  return (
    <div className={styles.row}>
      <section aria-label="Laps against the best possible lap" className={cx(ui.panel, styles.laps)}>
        <div className={styles.head}>
          <div className={ui.heading}>{hasIdeal ? `LAPS AGAINST THE BEST POSSIBLE LAP · ${formatLapTime(ideal.time_s)}` : "LAPS · NO VALID TIMED LAP FOR A BEST POSSIBLE LAP"}</div>
          <label className={styles.toggle}>
            <input type="checkbox" checked={validOnly} onChange={(e) => setValidOnly(e.target.checked)} /> Hide laps with track-limit cuts
          </label>
        </div>
        <div className={styles.segLegend} aria-label="Segments legend">
          Segments, one cell per part of the best possible lap:
          <span className={styles.legendItem}><span className={cx(styles.swatch, styles.purple)} /> holds the best possible time</span>
          <span className={styles.legendItem}><span className={cx(styles.swatch, styles.green)} /> close</span>
          <span className={styles.legendItem}><span className={cx(styles.swatch, styles.yellow)} /> slow</span>
          <span className={styles.legendItem}><span className={cx(styles.swatch, styles.red)} /> lost time</span>
        </div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Lap</th>
              <th scope="col">Kind</th>
              <th scope="col" className={styles.num}>Time</th>
              <th scope="col" className={styles.num}>Slower than best possible by</th>
              <th scope="col" className={styles.num}>Slower than your best by</th>
              <th scope="col">Segments</th>
              <th scope="col"><span className={styles.srOnly}>Open</span></th>
            </tr>
          </thead>
          <tbody>
            {laps.map((l) => {
              const g = gauges.get(l.lap_id);
              const tag = lapTag(l);
              return (
                <tr key={l.lap_id} className={cx(!l.has_trace && styles.noTrace)}>
                  <td className={styles.mono}>L{l.lap_no}</td>
                  <td>
                    <span className={cx(styles.tag, tag === "invalid" && styles.tagInvalid)}>{LAP_KIND_TEXT[tag]}</span>
                    {!l.has_trace && <span className={styles.tag} title="Recorded without a lap trace: only the stint stats are available"> numbers only, no replay</span>}
                  </td>
                  <td className={styles.num}>{g ? formatLapTime(g.lapTimeS) : l.lap_time_s ? formatLapTime(l.lap_time_s) : "—"}</td>
                  <td className={styles.num}>{g ? formatGap(g.gapToIdealS) : "—"}</td>
                  <td className={cx(styles.num, g?.gapToBestS === 0 && styles.best)}>{g ? (g.gapToBestS === 0 ? "best" : formatGap(g.gapToBestS)) : "—"}</td>
                  <td>{g ? <SegmentStrip cells={g.cells} lapId={l.lap_id} label={`L${l.lap_no} segments`} /> : <span className={styles.dim}>—</span>}</td>
                  <td className={styles.open}>
                    {l.has_trace ? (
                      <Link to={lapLink(search, l.lap_id)} className={styles.openLink} aria-label={`Open lap ${l.lap_no}`}>Open →</Link>
                    ) : (
                      <span className={styles.dim} title="No trace to open">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      {hasIdeal && <IdealBreakdown ideal={ideal} />}
    </div>
  );
}
