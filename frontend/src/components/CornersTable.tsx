import { useMemo, useState } from "react";
import type { Corner, CornerMetrics, TrackMap } from "../api/types";
import { cx } from "../lib/cx";
import { cornerRows, shiftWord, sortRows, type Cell, type CornerRow, type CornerSort } from "../lib/cornerTable";
import { formatDelta } from "../lib/format";
import styles from "./CornersTable.module.css";

export interface CornersTableProps {
  corners: CornerMetrics[];
  trackMap: TrackMap | null;
  onSeek(c: Corner): void;
  /** Short name of the comparison ("ideal", "L7"); absent reads "comparison". */
  refName?: string | null;
}

const f = (x: number | null, d: number) => (x === null ? "–" : x.toFixed(d));
const signed = (x: number | null, d: number, unit = "") =>
  x === null ? "–" : `${x < 0 ? "−" : x > 0 ? "+" : ""}${Math.abs(x).toFixed(d)}${unit}`;

interface Col {
  key: string;
  label: string;
  cell(r: CornerRow): Cell;
  show(x: number | null): string;
  diff(x: number | null): string;
  /** Hover text per side, where a landmark is close. */
  hint?(r: CornerRow, who: string): string | undefined;
  /** Which sign of the difference is worse (the lap lost time there), for the colour. */
  worse?: 1 | -1;
}

const near = (x: number | null) => (x === null ? "–" : `${Math.abs(Math.round(x))} m ${x <= 0 ? "before" : "after"} apex`);

const COLS: Col[] = [
  {
    key: "brake", label: "Brake point", cell: (r) => r.brake, show: near, diff: shiftWord,
    hint: (r, who) => hintText(r.brakeHint.lap, r.brakeHint.ref, who),
  },
  { key: "peak", label: "Peak brake %", cell: (r) => r.peakBrake, show: (x) => (x === null ? "–" : (x * 100).toFixed(0)), diff: (x) => (x === null ? "–" : signed(x * 100, 0)) },
  { key: "min", label: "Min speed km/h", cell: (r) => r.minSpeed, show: (x) => f(x, 0), diff: (x) => signed(x, 1), worse: -1 },
  { key: "minAt", label: "Min speed at", cell: (r) => r.minSpeedAt, show: near, diff: shiftWord },
  {
    key: "thr", label: "Throttle pickup", cell: (r) => r.throttle, show: near, diff: shiftWord,
    hint: (r, who) => hintText(r.throttleHint.lap, r.throttleHint.ref, who),
  },
  { key: "exit", label: "Exit km/h", cell: (r) => r.exitSpeed, show: (x) => f(x, 0), diff: (x) => signed(x, 1), worse: -1 },
  { key: "coast", label: "Coast s", cell: (r) => r.coast, show: (x) => f(x, 2), diff: (x) => signed(x, 2), worse: 1 },
  { key: "overlap", label: "Overlap s", cell: (r) => r.overlap, show: (x) => f(x, 2), diff: (x) => signed(x, 2), worse: 1 },
  { key: "steer", label: "Steer corr.", cell: (r) => r.steer, show: (x) => f(x, 0), diff: (x) => signed(x, 0), worse: 1 },
];

function hintText(lap: string | null, ref: string | null, who: string): string | undefined {
  if (!lap && !ref) return undefined;
  return `You: ${lap ?? "no close landmark"}. ${who[0].toUpperCase() + who.slice(1)}: ${ref ?? "no close landmark"}.`;
}

export function CornersTable({ corners, trackMap, onSeek, refName }: CornersTableProps) {
  const who = refName ?? "comparison";
  const [sort, setSort] = useState<CornerSort>("track");
  const all = useMemo(() => cornerRows(corners, trackMap), [corners, trackMap]);
  const rows = useMemo(() => sortRows(all, sort), [all, sort]);
  if (all.length === 0) return <div className={styles.empty}>No corner data for this comparison.</div>;
  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <caption className={styles.caption}>Corners: you / {who} / difference</caption>
        <thead>
          <tr>
            <th scope="col" className={styles.left}>
              <button
                type="button" className={styles.sortBtn} aria-pressed={sort === "track"}
                onClick={() => setSort("track")}
              >Corner</button>
            </th>
            <th scope="col">
              <button
                type="button" className={styles.sortBtn} aria-pressed={sort === "loss"}
                onClick={() => setSort("loss")}
              >Time lost</button>
            </th>
            {COLS.map((c) => <th key={c.key} scope="col">{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.corner.id} className={styles.row} onClick={() => onSeek(r.corner)}>
              <th scope="row" className={styles.left}>
                <button
                  type="button" className={styles.name}
                  aria-label={`${r.corner.name}. Seek to the corner`}
                >{r.corner.name}</button>
              </th>
              <td className={cx(styles.num, r.deltaS > 0 ? styles.loss : r.deltaS < 0 ? styles.gain : undefined)}>
                {formatDelta(r.deltaS)} s
              </td>
              {COLS.map((c) => {
                const x = c.cell(r);
                const bad = c.worse && x.diff !== null && Math.abs(x.diff) > 1e-9 ? Math.sign(x.diff) === c.worse : null;
                return (
                  <td key={c.key} className={styles.metric} title={c.hint?.(r, who)}>
                    <span>{c.show(x.lap)}</span>
                    <span className={styles.ref}>{c.show(x.ref)}</span>
                    <span className={cx(styles.diff, bad === true && styles.loss, bad === false && styles.gain)}>{c.diff(x.diff)}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
