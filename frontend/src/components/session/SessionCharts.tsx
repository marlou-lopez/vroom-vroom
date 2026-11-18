// The session tab's charts (vroom-bi4.12): lap time per lap with event markers, and small per-lap charts of tyre temperature,
// pressure and brake temperature with the working window as a band and a line where an in-car setting changed.
// Drawn like the Stint view's plot (stretched SVG for lines and bands, HTML for the round, clickable points).
import { useMemo } from "react";
import type { ReportEvent, ReportLap, ReportSeverity, ReportWindow } from "../../api/types";
import { cx } from "../../lib/cx";
import { formatLapTime } from "../../lib/format";
import { CHARTS, lapSeverity, lapTimeRange, settingChanges, windowFor, yRange, type ChartMetric } from "../../lib/sessionTab";
import styles from "./Session.module.css";

const H = 140;
const SEVERITY_LABEL: Record<ReportSeverity, string> = { info: "info", watch: "watch", problem: "problem" };

interface Frame { xPct: (lapNo: number) => number; first: number; last: number }

function frameFor(laps: ReportLap[]): Frame {
  const first = Math.min(...laps.map((l) => l.lap_no)), last = Math.max(...laps.map((l) => l.lap_no));
  const n = last - first + 1;
  return { first, last, xPct: (no) => ((no - first + 0.5) / n) * 100 };
}

function SettingLines({ frame, events }: { frame: Frame; events: ReportEvent[] }) {
  return (
    <>
      {events.map((e) => (
        <line key={e.id} x1={frame.xPct(e.lap_from) * 10} x2={frame.xPct(e.lap_from) * 10} y1={0} y2={H} className={styles.settingLine}>
          <title>{e.sentence}</title>
        </line>
      ))}
    </>
  );
}

function LapAxis({ frame, laps }: { frame: Frame; laps: ReportLap[] }) {
  // A label every few laps so the axis stays readable on a long race.
  const step = Math.max(1, Math.ceil(laps.length / 12));
  return (
    <div className={styles.lapAxis} aria-hidden="true">
      {laps.filter((l) => (l.lap_no - frame.first) % step === 0).map((l) => (
        <span key={l.lap_no} style={{ left: `${frame.xPct(l.lap_no)}%` }}>{l.lap_no}</span>
      ))}
    </div>
  );
}

const kindText = (l: ReportLap) => (l.kind === "flying" ? (l.valid ? "" : "invalid") : l.kind === "incomplete" ? "incomplete" : `${l.kind} lap`);

export function LapTimeChart({ laps, events, onOpenLap }: { laps: ReportLap[]; events: ReportEvent[]; onOpenLap(lap: ReportLap): void }) {
  const frame = useMemo(() => frameFor(laps), [laps]);
  const range = useMemo(() => lapTimeRange(laps), [laps]);
  const severity = useMemo(() => lapSeverity(events), [events]);
  const changes = useMemo(() => settingChanges(events), [events]);
  // Fastest at the top; timed laps use the top 88 % so laps without a time (drawn at the very bottom) never sit on a real one.
  const yPct = (t: number) => (range ? Math.min(88, Math.max(0, ((t - range.lo) / (range.hi - range.lo)) * 88)) : 100);
  return (
    <figure className={styles.chart} aria-label="Lap times across the session">
      <figcaption className={styles.chartTitle}>Lap time</figcaption>
      <div className={styles.plot} style={{ height: H }}>
        <svg viewBox={`0 0 1000 ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <path d={`M0 ${H * 0.25} L1000 ${H * 0.25} M0 ${H * 0.5} L1000 ${H * 0.5} M0 ${H * 0.75} L1000 ${H * 0.75}`} className={styles.gridLine} />
          <SettingLines frame={frame} events={changes} />
        </svg>
        {range && <><div className={cx(styles.axis, styles.axisTop)}>{formatLapTime(range.lo)}</div><div className={styles.axis} style={{ top: "88%" }}>{formatLapTime(range.hi)}</div></>}
        {laps.map((l) => {
          const timed = l.lap_time_s !== null && l.lap_time_s > 0 && range !== null;
          const sev = severity.get(l.lap_no);
          const flying = l.kind === "flying" && l.valid;
          const tag = kindText(l);
          const label = `Lap ${l.lap_no}${timed ? ` ${formatLapTime(l.lap_time_s)}` : ""}${tag ? ` (${tag})` : ""}${sev ? `, ${SEVERITY_LABEL[sev]} events` : ""}${l.has_trace ? "" : ", no trace"}`;
          return (
            <button
              key={l.lap_id} type="button" aria-label={label} title={label}
              className={cx(styles.dot, !flying && styles.dotOut, l.kind === "flying" && !l.valid && styles.dotInvalid, !l.has_trace && styles.dotNoTrace)}
              style={{ left: `${frame.xPct(l.lap_no)}%`, top: `${timed ? yPct(l.lap_time_s as number) : 100}%` }}
              onClick={() => onOpenLap(l)}
            >
              {sev && <span className={cx(styles.mark, styles[`sev_${sev}`])} aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <LapAxis frame={frame} laps={laps} />
      <div className={styles.legend}>
        <span><span className={styles.key} /> flying lap</span>
        <span><span className={cx(styles.key, styles.dotOut)} /> out, in or incomplete lap (at the bottom: no time)</span>
        <span><span className={cx(styles.key, styles.dotOut, styles.dotInvalid)} /> invalid lap</span>
        <span><span className={cx(styles.mark, styles.sev_watch, styles.keyMark)} /> lap with events</span>
        <span><span className={styles.settingKey} /> in-car setting changed</span>
      </div>
    </figure>
  );
}

export function MetricChart({ metric, laps, windows, events, onOpenLap }: {
  metric: ChartMetric; laps: ReportLap[]; windows: ReportWindow[]; events: ReportEvent[]; onOpenLap(lap: ReportLap): void;
}) {
  const spec = CHARTS.find((c) => c.metric === metric)!;
  const frame = useMemo(() => frameFor(laps), [laps]);
  const win = windowFor(windows, metric);
  const points = useMemo(() => laps.flatMap((l) => { const a = spec.pick(l); return a ? [{ lap: l, ...a }] : []; }), [laps, spec]);
  const range = useMemo(() => yRange(points.flatMap((p) => [p.front, p.rear]), win), [points, win]);
  const changes = useMemo(() => settingChanges(events), [events]);
  if (!range || points.length === 0) return null;
  const y = (v: number) => ((range.hi - v) / (range.hi - range.lo)) * H;
  const path = (get: (p: (typeof points)[number]) => number) => points.map((p, i) => `${i === 0 ? "M" : "L"}${frame.xPct(p.lap.lap_no) * 10} ${y(get(p))}`).join(" ");
  return (
    <figure className={styles.chart} aria-label={`${spec.title} per lap`}>
      <figcaption className={styles.chartTitle}>
        {spec.title} ({spec.unit})
        {win && <span className={styles.windowNote} title={win.source}> · window {win.min}–{win.max} {win.unit}</span>}
      </figcaption>
      <div className={styles.plot} style={{ height: 110 }}>
        <svg viewBox={`0 0 1000 ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {win && <rect x={0} width={1000} y={y(win.max)} height={Math.max(0, y(win.min) - y(win.max))} className={styles.windowBand} data-testid={`window-${metric}`} />}
          <SettingLines frame={frame} events={changes} />
          <path d={path((p) => p.front)} className={styles.lineFront} />
          <path d={path((p) => p.rear)} className={styles.lineRear} />
        </svg>
        <div className={cx(styles.axis, styles.axisTop)}>{Math.round(range.hi)}</div>
        <div className={cx(styles.axis, styles.axisBottom)}>{Math.round(range.lo)}</div>
        {points.map((p) => (
          <button
            key={p.lap.lap_id} type="button" className={styles.hit} style={{ left: `${frame.xPct(p.lap.lap_no)}%` }}
            aria-label={`${spec.title}, lap ${p.lap.lap_no}: front ${p.front.toFixed(0)}, rear ${p.rear.toFixed(0)} ${spec.unit}`}
            title={`Lap ${p.lap.lap_no}: front ${p.front.toFixed(0)}, rear ${p.rear.toFixed(0)} ${spec.unit}`}
            onClick={() => onOpenLap(p.lap)}
          />
        ))}
      </div>
      <LapAxis frame={frame} laps={laps} />
      <div className={styles.legend}>
        <span><span className={cx(styles.swatch, styles.swatchFront)} /> front axle</span>
        <span><span className={cx(styles.swatch, styles.swatchRear)} /> rear axle</span>
        {win && <span><span className={cx(styles.swatch, styles.swatchWindow)} /> working window</span>}
      </div>
    </figure>
  );
}
