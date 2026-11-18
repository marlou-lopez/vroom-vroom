import { Link } from "react-router-dom";
import type { IdealLap } from "../api/types";
import { formatLapTime } from "../lib/format";
import { useLocation } from "react-router-dom";
import { lapLink } from "../lib/urlParams";
import { cx } from "../lib/cx";
import ui from "./ui.module.css";
import styles from "./IdealBreakdown.module.css";

/**
 * The ideal lap segment by segment: the lap each best time came from and the time. A row opens that lap at that segment.
 * Whole rows are links, so they are reachable with Tab and open with Enter.
 */
export function IdealBreakdown({ ideal }: { ideal: IdealLap }) {
  const { search } = useLocation();
  return (
    <section aria-label="Best possible lap breakdown" className={cx(ui.panel, styles.panel)}>
      <div className={styles.head}>
        <div className={ui.heading}>BEST POSSIBLE LAP · BREAKDOWN</div>
        <div className={styles.total}>{formatLapTime(ideal.time_s)}</div>
      </div>
      <ol className={styles.list}>
        {ideal.segments.map((s, i) => (
          <li key={i}>
            <Link to={lapLink(search, s.lap_id, s.start_m)} className={styles.row} aria-label={`${s.label}, ${s.best_s.toFixed(3)} seconds, lap ${s.lap_no}. Open`}>
              <span className={styles.label}>{s.label}</span>
              <span className={styles.lap}>L{s.lap_no}</span>
              <span className={styles.time}>{s.best_s.toFixed(3)}</span>
              <span className={styles.go} aria-hidden="true">→</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

