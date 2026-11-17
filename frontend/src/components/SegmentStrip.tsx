import { Link } from "react-router-dom";
import { useLocation } from "react-router-dom";
import { lapLink } from "../lib/urlParams";
import { type SegmentCell } from "../lib/idealGauge";
import { cx } from "../lib/cx";
import styles from "./SegmentStrip.module.css";

const TONE_NAME = { purple: "holds the ideal", green: "close", yellow: "slow", red: "lost time" } as const;

const cellTitle = (c: SegmentCell) =>
  `${c.label}: ${c.time_s.toFixed(3)} s, ${c.tone === "purple" ? TONE_NAME.purple : `+${c.loss_s.toFixed(3)} s (${TONE_NAME[c.tone]})`}`;

/**
 * One cell per segment of the ideal lap: purple where the lap holds the ideal segment, then green, yellow, red by time lost.
 * With a `lapId` each cell links to the lap opened at that segment (keyboard-reachable); without, the strip is one labelled picture
 * (inside a menu item, which is itself the focus stop).
 */
export function SegmentStrip({ cells, lapId, label }: { cells: SegmentCell[]; lapId?: string; label: string }) {
  const { search } = useLocation();
  if (!lapId) {
    const held = cells.filter((c) => c.tone === "purple").length;
    return (
      <span role="img" className={styles.strip} aria-label={`${label}: holds ${held} of ${cells.length} ideal segments`}>
        {cells.map((c, i) => <span key={i} className={cx(styles.cell, styles[c.tone])} title={cellTitle(c)} />)}
      </span>
    );
  }
  return (
    <span role="group" className={styles.strip} aria-label={label}>
      {cells.map((c, i) => (
        <Link key={i} to={lapLink(search, lapId, c.start_m)} className={cx(styles.cell, styles.link, styles[c.tone])} title={cellTitle(c)} aria-label={cellTitle(c)} />
      ))}
    </span>
  );
}
