import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Corner, CornerMetrics, TrackMap } from "../api/types";
import { cx } from "../lib/cx";
import { cornerRows, nearApex, shiftWord, signedNumber, signedSeconds, sortRows, type Cell, type CornerRow, type CornerSort } from "../lib/cornerTable";
import styles from "./CornersTable.module.css";

export interface CornersTableProps {
  corners: CornerMetrics[];
  trackMap: TrackMap | null;
  onSeek(c: Corner): void;
  /** Short name of the comparison ("ideal", "L7"); absent reads "reference". */
  refName?: string | null;
}

const f = (x: number | null, d: number) => (x === null ? "–" : x.toFixed(d));
const signed = signedNumber;

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

const near = nearApex;

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
  const who = refName ?? "reference";
  const [sort, setSort] = useState<CornerSort>("track");
  const [expanded, setExpanded] = useState(false);
  const [edges, setEdges] = useState({ left: false, right: false });
  const wrapRef = useRef<HTMLDivElement>(null);
  const all = useMemo(() => cornerRows(corners, trackMap), [corners, trackMap]);
  const rows = useMemo(() => sortRows(all, sort), [all, sort]);
  const measure = (el: HTMLDivElement | null) => {
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  };
  useLayoutEffect(() => {
    measure(wrapRef.current);
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure(el));
    ro.observe(el);
    return () => ro.disconnect();
  }, [all.length, expanded, corners]);
  if (all.length === 0) return <div className={styles.empty}>No corner data for this comparison.</div>;
  const sortHeader = (key: CornerSort, label: string) => (
    <button
      type="button" className={styles.sortBtn} aria-pressed={sort === key}
      aria-label={label} onClick={() => setSort(key)}
    >
      {label}<span aria-hidden className={styles.arrow} data-on={sort === key || undefined}>{sort === key ? "↓" : "↕"}</span>
    </button>
  );
  return (
    <div className={styles.outer} data-shadow-left={edges.left || undefined} data-shadow-right={edges.right || undefined}>
      <div className={styles.toolbar}>
        <button
          type="button" className={styles.expandBtn} aria-pressed={expanded}
          onClick={() => setExpanded((x) => !x)}
        >{expanded ? "Show difference only" : `Show you / ${who}`}</button>
      </div>
      {/* A scrollable region must be keyboard-reachable so the table can be scrolled sideways. */}
      <div
        className={styles.wrap} ref={wrapRef}
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        role="region" tabIndex={0}
        onScroll={(e) => measure(e.currentTarget)} aria-label="Corner details, scrolls sideways"
      >
        <table className={styles.table}>
          <caption className={styles.caption}>Corners: difference to {who} (hover a cell for you and {who})</caption>
          <thead>
            <tr>
              <th scope="col" className={styles.left}>{sortHeader("track", "Corner")}</th>
              <th scope="col">{sortHeader("loss", "Time lost")}</th>
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
                  {signedSeconds(r.deltaS)} s
                </td>
                {COLS.map((c) => {
                  const x = c.cell(r);
                  const bad = c.worse && x.diff !== null && Math.abs(x.diff) > 1e-9 ? Math.sign(x.diff) === c.worse : null;
                  const both = `You ${c.show(x.lap)} · ${who[0].toUpperCase() + who.slice(1)} ${c.show(x.ref)}`;
                  const hint = c.hint?.(r, who);
                  return (
                    <td key={c.key} className={styles.metric} title={hint ? `${both}. ${hint}` : both}>
                      {expanded && <span>{c.show(x.lap)}</span>}
                      {expanded && <span className={styles.ref}>{c.show(x.ref)}</span>}
                      <span className={cx(styles.diff, bad === true && styles.loss, bad === false && styles.gain)}>{c.diff(x.diff)}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
