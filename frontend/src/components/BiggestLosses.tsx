import type { BiggestLosses as Result, CornerLoss } from "../lib/biggestLosses";
import { CAUSE_WORD } from "../lib/biggestLosses";
import { cx } from "../lib/cx";
import { formatDelta } from "../lib/format";
import styles from "./BiggestLosses.module.css";

export interface BiggestLossesProps {
  result: Result | null;
  onSeek(l: CornerLoss): void;
}

export function BiggestLosses({ result, onSeek }: BiggestLossesProps) {
  if (!result || (result.losses.length === 0 && !result.gain)) return null;
  const item = (l: CornerLoss, gain: boolean) => (
    <li key={l.cornerId}>
      <button
        type="button" className={styles.item}
        aria-label={`${l.name}, ${gain ? "gained" : "lost"} ${Math.abs(l.deltaS).toFixed(3)} seconds, ${CAUSE_WORD[l.cause]}. Seek to the corner`}
        onClick={() => onSeek(l)}
      >
        <span className={styles.name}>{l.name}</span>
        <span className={cx(styles.time, gain ? styles.gain : styles.loss)}>{formatDelta(l.deltaS)} s</span>
        <span className={styles.cause}>{CAUSE_WORD[l.cause]}</span>
      </button>
    </li>
  );
  return (
    <section aria-label="Biggest losses" className={styles.row}>
      <span className={styles.title}>Biggest losses</span>
      <ul className={styles.list}>
        {result.losses.map((l) => item(l, false))}
        {result.gain && item(result.gain, true)}
      </ul>
    </section>
  );
}
