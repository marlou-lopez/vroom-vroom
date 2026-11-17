import { useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { CompareResponse, TrackGeometry } from "../api/types";
import type { Annotation } from "../lib/annotations";
import { aidRuns, type AidRuns, type Run } from "../lib/driverAids";
import { cleanGear, gearName, gearShifts, shiftLabel, type Shift } from "../lib/gearShifts";
import { formatDelta } from "../lib/format";
import type { PlaybackModel } from "../lib/model";
import { distanceAtTime, formatSteering, indexAtTime, timeAtDistance } from "../lib/playback";
import { chipLayerGeometry, cornerBands, clipBand, elevationRange, stripDistanceAt, stripRanges, stripScrubTarget, stripWindow, withAlpha, type Range } from "../lib/strips";
import { usePlaybackStore } from "../state/playback";
import { colors, fonts } from "../theme";
import styles from "./DetailedStrips.module.css";
import { ChipLayer, type BadgeHandlers } from "./AnnotationOverlays";

export const STRIP_HALF_M = 350;
const SYNC_KEY = "telemetry-strips";
const MIN_STRIP_H = 72;
const PAD_Y = 4;
const DRAG_THRESHOLD_PX = 4;
const STEP_M = 10;
const BIG_STEP_M = 100;
const IGNORE_SELECTOR = "button,[data-annotation-badge]";

interface Gesture {
  pointerId: number;
  startX: number;
  startD: number;
  resume: boolean;
  dragging: boolean;
}

export interface DetailedStripsProps {
  model: PlaybackModel;
  /** The track's elevation (`api.trackGeometry`); the elevation strip shows when it has one. */
  geometry: TrackGeometry | null;
  annotations: Annotation[];
  handlers: BadgeHandlers;
}

type Num = (number | null)[];
interface Spec {
  label: string;
  /** Marked "exp" next to the label. */
  experimental?: boolean;
  yRange: Range;
  data: Num[];
  series: uPlot.Series[];
  zeroLine?: boolean;
  deltaFill?: boolean;
  /** Driver aids and slip marks of this lap, drawn on the pedals strip (vroom-pnw.14). */
  aids?: { runs: AidRuns; throttle: number[]; brake: number[] };
  /** Gear shifts of both laps, marked on the pedals strip (vroom-pnw.12). */
  shifts?: { lap: Shift[]; ref: Shift[] };
  value: (cmp: CompareResponse, tau: number, iy: number) => string;
}

const line = (stroke: string, width: number): uPlot.Series => ({
  stroke, width, points: { show: false }, spanGaps: true,
});

const stepLine = (stroke: string, width: number): uPlot.Series => ({
  ...line(stroke, width), paths: uPlot.paths.stepped!({ align: 1 }),
});

/** Gear axis: half a gear of room either side of the gears used by both laps. */
function gearRange(...gears: number[][]): Range {
  let lo = Infinity;
  let hi = -Infinity;
  for (const a of gears) for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return Number.isFinite(lo) ? [lo - 0.5, hi + 0.5] : [0.5, 7.5];
}

function buildSpecs(cmp: CompareResponse, geometry: TrackGeometry | null): Spec[] {
  const r = stripRanges(cmp);
  const gl = cleanGear(cmp.lap.gear);
  const gr = cleanGear(cmp.ref.gear);
  const refStroke = withAlpha(colors.comparison, 0.8);
  const specs: Spec[] = [
    {
      label: "SPEED", yRange: r.speed,
      data: [cmp.ref.speed_kmh, cmp.lap.speed_kmh],
      series: [line(refStroke, 1.2), line(colors.you, 1.6)],
      value: (c, tau, iy) => `${Math.round(c.lap.speed_kmh[iy])} / ${Math.round(c.ref.speed_kmh[indexAtTime(c.ref.t, tau)])}`,
    },
    {
      label: "THROTTLE · BRAKE", yRange: r.pedals,
      data: [cmp.ref.throttle, cmp.ref.brake, cmp.lap.throttle, cmp.lap.brake],
      series: [
        line(withAlpha(colors.throttle, 0.45), 1.2), line(withAlpha(colors.brake, 0.45), 1.2),
        line(colors.throttle, 1.6), line(colors.brake, 1.6),
      ],
      aids: { runs: aidRuns(cmp.lap), throttle: cmp.lap.throttle, brake: cmp.lap.brake },
      shifts: { lap: gearShifts(cmp.lap.gear), ref: gearShifts(cmp.ref.gear) },
      value: (c, _t, iy) => `${Math.round(c.lap.throttle[iy] * 100)}% · ${Math.round(c.lap.brake[iy] * 100)}%`
        + (c.lap.abs[iy] ? " · ABS" : "") + (c.lap.tc[iy] ? " · TC" : ""),
    },
    {
      label: "GEAR", yRange: gearRange(gl, gr),
      data: [gr, gl],
      series: [stepLine(refStroke, 1.2), stepLine(colors.you, 1.6)],
      value: (c, tau, iy) => `${gearName(gl[iy])} / ${gearName(gr[indexAtTime(c.ref.t, tau)] ?? 0)}`,
    },
    {
      // Plotted on the normalised scale so both cars share one axis; the label uses steeringDisplay units.
      label: "STEERING", yRange: r.steering,
      data: [cmp.ref.steering, cmp.lap.steering],
      series: [line(refStroke, 1.2), line(colors.you, 1.6)],
      value: (c, _t, iy) => formatSteering(c.lap.steering[iy], c.lap_steering_range_deg),
    },
    {
      label: "DELTA", yRange: r.delta,
      data: [cmp.delta],
      series: [line(colors.textSoft, 1.6)],
      zeroLine: true, deltaFill: true,
      value: (c, _t, iy) => `${formatDelta(c.delta[iy])} s`,
    },
  ];
  const track = geometry?.elevation_m;
  if (track) {
    // Game world height from a shared-memory capture (#94), a property of the track so one line for both laps; in metres.
    const n = cmp.distance.length;
    const e = Array.from({ length: n }, (_, i) => track[i] ?? null);
    const m = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toFixed(1));
    specs.push({
      label: "ELEVATION", experimental: true, yRange: elevationRange(e),
      data: [e],
      series: [line(colors.textSoft, 1.6)],
      value: (_c, _t, iy) => `${m(e[iy])} m`,
    });
  }
  return specs;
}

/** Corner bands, drawn on the canvas so they move with the data. */
function drawBands(u: uPlot, anns: Annotation[]) {
  const { ctx, bbox } = u;
  const dpr = uPlot.pxRatio;
  const xs = u.data[0];
  const lapEnd = xs[xs.length - 1];
  const onScreen = (x: number) => x >= bbox.left && x <= bbox.left + bbox.width;
  for (const a of anns) {
    // A corner over the start line is two bands: its start to the lap end, and the lap start to its end.
    for (const { d0, d1, startEdge, endEdge } of cornerBands(a.startM, a.endM, lapEnd)) {
      const x0 = bbox.left + u.valToPos(d0, "x", true);
      const x1 = bbox.left + u.valToPos(d1, "x", true);
      const c = clipBand(x0, x1, bbox.left, bbox.width);
      if (!c) continue;
      ctx.fillStyle = withAlpha(a.color, 0.1);
      ctx.fillRect(c[0], bbox.top, c[1] - c[0], bbox.height);
      // Edge lines only at the corner's real edges, and only where on screen.
      ctx.fillStyle = withAlpha(a.color, 0.33);
      if (startEdge && onScreen(x0)) ctx.fillRect(x0, bbox.top, dpr, bbox.height);
      if (endEdge && onScreen(x1)) ctx.fillRect(x1 - dpr, bbox.top, dpr, bbox.height);
    }
  }
}

const AID_BAND_ALPHA = 0.22;
const MARK_PX = 3;

/** Light bands under a trace where an aid was active: from the baseline up to the trace, only over the runs. */
function drawAidBands(u: uPlot, runs: Run[], values: number[], color: string) {
  const { ctx, bbox } = u;
  const xs = u.data[0];
  const sx = u.scales.x;
  const lo = sx.min ?? xs[0], hi = sx.max ?? xs[xs.length - 1];
  const baseY = bbox.top + u.valToPos(0, "y", true);
  const px = (i: number) => bbox.left + u.valToPos(xs[i], "x", true);
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  ctx.fillStyle = withAlpha(color, AID_BAND_ALPHA);
  for (const r of runs) {
    if (xs[r.end] < lo || xs[r.start] > hi) continue;
    ctx.beginPath();
    ctx.moveTo(px(r.start) - dprHalf(), baseY);
    for (let i = r.start; i <= r.end; i++) ctx.lineTo(px(i), bbox.top + u.valToPos(values[i], "y", true));
    ctx.lineTo(px(r.end) + dprHalf(), baseY);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
const dprHalf = () => uPlot.pxRatio / 2;

/** Marks on a trace where a wheel locked (red, brake trace) or spun (amber, throttle trace): a thick stroke over the line with a dark casing. */
function drawSlipMarks(u: uPlot, runs: Run[], values: number[], color: string) {
  const { ctx, bbox } = u;
  const xs = u.data[0];
  const sx = u.scales.x;
  const lo = sx.min ?? xs[0], hi = sx.max ?? xs[xs.length - 1];
  const px = (i: number) => bbox.left + u.valToPos(xs[i], "x", true);
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [stroke, width] of [[colors.bg, MARK_PX + 2], [color, MARK_PX]] as const) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width * uPlot.pxRatio;
    for (const r of runs) {
      if (xs[r.end] < lo || xs[r.start] > hi) continue;
      ctx.beginPath();
      ctx.moveTo(px(r.start), bbox.top + u.valToPos(values[r.start], "y", true));
      // A one-metre run is a dot (a zero-length line with round caps).
      if (r.end === r.start) ctx.lineTo(px(r.start) + 0.01, bbox.top + u.valToPos(values[r.start], "y", true));
      for (let i = r.start + 1; i <= r.end; i++) ctx.lineTo(px(i), bbox.top + u.valToPos(values[i], "y", true));
      ctx.stroke();
    }
  }
  ctx.restore();
}

const SHIFT_TICK_PX = 6;

/** A tick and a `3→4` label at each shift, at the top of the strip; the comparison lap's are dimmer. */
function drawShiftMarks(u: uPlot, shifts: Shift[], color: string, row: number) {
  const { ctx, bbox } = u;
  const xs = u.data[0];
  const sx = u.scales.x;
  const lo = sx.min ?? xs[0], hi = sx.max ?? xs[xs.length - 1];
  const dpr = uPlot.pxRatio;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  ctx.fillStyle = color;
  ctx.font = `${10 * dpr}px ${fonts.mono}`;
  ctx.textBaseline = "top";
  // The lap's markers sit at the top, the comparison lap's on a second row below, so labels of the two do not overlap.
  const y0 = bbox.top + row * 12 * dpr;
  for (const s of shifts) {
    const m = xs[s.i];
    if (m < lo - 5 || m > hi + 5) continue;
    const x = bbox.left + u.valToPos(m, "x", true);
    ctx.fillRect(x - dpr / 2, y0, dpr, SHIFT_TICK_PX * dpr);
    ctx.fillText(shiftLabel(s), x + 2 * dpr, y0 + dpr);
  }
  ctx.restore();
}

/** Zero line plus the area between the delta line and zero: issue colour above (losing time), strength below. */
function drawDelta(u: uPlot, zeroLine: boolean, fill: boolean) {
  const { ctx, bbox } = u;
  const xs = u.data[0];
  const ys = u.data[1];
  const zeroY = u.valToPos(0, "y", true) + bbox.top;
  if (zeroLine) {
    ctx.fillStyle = colors.borderStrong;
    ctx.fillRect(bbox.left, Math.round(zeroY), bbox.width, Math.max(1, Math.round(uPlot.pxRatio)));
  }
  if (!fill || xs.length < 2) return;
  const sx = u.scales.x;
  const i0 = Math.max(0, u.valToIdx(sx.min ?? xs[0]) - 1);
  const i1 = Math.min(xs.length - 1, u.valToIdx(sx.max ?? xs[xs.length - 1]) + 1);
  const px = (i: number) => bbox.left + u.valToPos(xs[i], "x", true);
  const py = (i: number) => bbox.top + u.valToPos(ys[i] as number, "y", true);
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  for (const [positive, color] of [[true, colors.issue], [false, colors.strength]] as const) {
    ctx.save();
    ctx.beginPath();
    // Positive delta plots above zero (smaller canvas y).
    if (positive) ctx.rect(bbox.left, bbox.top, bbox.width, zeroY - bbox.top);
    else ctx.rect(bbox.left, zeroY, bbox.width, bbox.top + bbox.height - zeroY);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(px(i0), zeroY);
    for (let i = i0; i <= i1; i++) ctx.lineTo(px(i), py(i));
    ctx.lineTo(px(i1), zeroY);
    ctx.closePath();
    ctx.fillStyle = withAlpha(color, 0.25);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function makeOptions(spec: Spec, w: number, h: number, annRef: { current: Annotation[] }): uPlot.Options {
  return {
    width: w, height: h,
    padding: [PAD_Y, 0, PAD_Y, 0],
    legend: { show: false },
    cursor: { sync: { key: SYNC_KEY }, drag: { x: false, y: false, setScale: false }, points: { show: false }, y: false },
    select: { show: false, left: 0, top: 0, width: 0, height: 0 },
    axes: [{ show: false }, { show: false }],
    scales: {
      // Both scales are driven from outside; never auto-range from the data.
      x: { time: false, auto: false, range: (_u, min, max) => [min, max] },
      y: { auto: false, range: () => spec.yRange },
    },
    series: [{}, ...spec.series],
    hooks: {
      drawClear: [
        (u) => {
          drawBands(u, annRef.current);
          if (spec.zeroLine || spec.deltaFill) drawDelta(u, !!spec.zeroLine, !!spec.deltaFill);
          if (spec.aids) {
            drawAidBands(u, spec.aids.runs.abs, spec.aids.brake, colors.brake);
            drawAidBands(u, spec.aids.runs.tc, spec.aids.throttle, colors.throttle);
          }
        },
      ],
      draw: [
        (u) => {
          if (!spec.aids) return;
          drawSlipMarks(u, spec.aids.runs.lockup, spec.aids.brake, colors.lockup);
          drawSlipMarks(u, spec.aids.runs.wheelspin, spec.aids.throttle, colors.wheelspin);
          if (spec.shifts) {
            drawShiftMarks(u, spec.shifts.ref, withAlpha(colors.comparison, 0.5), 1);
            drawShiftMarks(u, spec.shifts.lap, colors.you, 0);
          }
        },
      ],
    },
  };
}

/**
 * Five uPlot strips (six when the track has an elevation capture). React renders this once per comparison / annotation set. Per frame, an effect subscribed to
 * the playback store moves each chart's x scale synchronously, the chip layer and the value read-outs imperatively.
 */
export function DetailedStrips({ model, geometry, annotations, handlers }: DetailedStripsProps) {
  const store = usePlaybackStore();
  const { cmp } = model;
  const specList = useMemo(() => buildSpecs(cmp, geometry), [cmp, geometry]);
  const hosts = useRef<(HTMLDivElement | null)[]>([]);
  const frames = useRef<(HTMLDivElement | null)[]>([]);
  const values = useRef<(HTMLDivElement | null)[]>([]);
  const playheads = useRef<(HTMLDivElement | null)[]>([]);
  /** The x window currently shown (metres); clicks map through it. */
  const shown = useRef({ min: 0, max: 2 * STRIP_HALF_M });
  const chipLayer = useRef<HTMLDivElement | null>(null);
  const charts = useRef<uPlot[]>([]);
  const annRef = useRef(annotations);
  const gesture = useRef<Gesture | null>(null);
  const wasDrag = useRef(false);

  // Bands read the latest annotations from the ref; a new set only needs a canvas redraw.
  useLayoutEffect(() => {
    annRef.current = annotations;
    charts.current.forEach((u) => u.redraw());
  }, [annotations]);

  useEffect(() => {
    const specs = specList;
    const xs = cmp.distance;
    const dMin = xs[0] ?? 0;
    const dMax = xs[xs.length - 1] ?? 0;
    const us = specs.map((spec, i) => {
      const host = hosts.current[i]!;
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(MIN_STRIP_H, host.clientHeight);
      return new uPlot(makeOptions(spec, w, h, annRef), [xs, ...spec.data] as uPlot.AlignedData, host);
    });
    charts.current = us;

    let lastTau = NaN;
    let lastMin = 0;
    let lastMax = 0;

    const placeChips = () => {
      const layer = chipLayer.current;
      const over = us[0].over;
      if (!layer || over.clientWidth <= 0) return;
      const g = chipLayerGeometry(lastMin, lastMax, over.clientWidth, over.offsetLeft, dMin, dMax);
      layer.style.width = `${g.widthPx}px`;
      layer.style.transform = `translateX(${g.offsetPx}px)`;
    };

    // Runs synchronously from the store listener. The store ticks inside the app's rAF, so this lands in the same
    // frame as the map and scrubber. Skipped when the playhead has not moved (cmp is fixed for this effect).
    const apply = () => {
      const tau = store.get().tau;
      if (tau === lastTau) return;
      // oxlint-disable-next-line react/immutability -- local of this effect's own closure, not render state
      lastTau = tau;
      const d = distanceAtTime(cmp.lap.t, xs, tau);
      // Clamped to the lap: near the start or end the window stops and the playhead line moves off centre instead.
      const win = stripWindow(d, STRIP_HALF_M, dMin, dMax);
      lastMin = win.min;
      lastMax = win.max;
      shown.current = { min: win.min, max: win.max };
      for (const u of us) u.setScale("x", { min: lastMin, max: lastMax });
      const left = `${(win.playhead * 100).toFixed(3)}%`;
      for (const el of playheads.current) if (el) el.style.left = left;
      placeChips();
      const iy = indexAtTime(cmp.lap.t, tau);
      specs.forEach((s, i) => {
        const el = values.current[i];
        if (el) el.textContent = s.value(cmp, tau, iy);
      });
    };

    const ro = new ResizeObserver(() => {
      us.forEach((u, i) => {
        const f = frames.current[i];
        if (f && f.clientWidth > 0 && f.clientHeight > 0) u.setSize({ width: f.clientWidth, height: f.clientHeight });
      });
      placeChips();
    });
    frames.current.forEach((f) => f && ro.observe(f));

    const unsub = store.subscribe(apply);
    apply();

    return () => {
      unsub();
      ro.disconnect();
      us.forEach((u) => u.destroy());
      charts.current = [];
    };
  }, [cmp, store, specList]);

  const lapRange = (): [number, number] => {
    const xs = cmp.distance;
    return [xs[0] ?? 0, xs[xs.length - 1] ?? 0];
  };
  const centreM = () => distanceAtTime(cmp.lap.t, cmp.distance, store.get().tau);
  const seekToDistance = (d: number) => {
    const [lo, hi] = lapRange();
    store.seek(timeAtDistance(cmp.lap.t, cmp.distance, Math.min(Math.max(d, lo), hi)));
  };
  // Events from chips, badges and their portalled hover cards bubble here through React; they keep their own behaviour.
  const foreign = (e: { currentTarget: Element; target: EventTarget }) =>
    !e.currentTarget.contains(e.target as Node) || !!(e.target as Element).closest(IGNORE_SELECTOR);
  const plotWidth = () => charts.current[0]?.over.clientWidth ?? 0;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    wasDrag.current = false;
    if (e.button !== 0 || gesture.current || foreign(e)) return;
    gesture.current = {
      pointerId: e.pointerId, startX: e.clientX, startD: centreM(), resume: store.get().playing, dragging: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const dx = e.clientX - g.startX;
    if (!g.dragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      g.dragging = true;
      e.currentTarget.setAttribute("data-dragging", "");
      store.pause();
    }
    const [lo, hi] = lapRange();
    store.seek(timeAtDistance(cmp.lap.t, cmp.distance, stripScrubTarget(g.startD, dx, plotWidth(), STRIP_HALF_M, lo, hi)));
  };

  const endGesture = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    e.currentTarget.removeAttribute("data-dragging");
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (g.dragging) {
      wasDrag.current = true;
      if (g.resume) store.play();
    }
  };

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (foreign(e) || wasDrag.current) return;
    if (e.detail === 1) {
      const over = charts.current[0]?.over;
      if (!over) return;
      const { min, max } = shown.current;
      seekToDistance(stripDistanceAt(e.clientX - over.getBoundingClientRect().left, over.clientWidth, (min + max) / 2, (max - min) / 2));
    } else if (e.detail === 2) {
      store.toggle();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === " ") {
      store.toggle();
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const step = (e.shiftKey ? BIG_STEP_M : STEP_M) * (e.key === "ArrowRight" ? 1 : -1);
      seekToDistance(centreM() + step);
    } else {
      return;
    }
    e.preventDefault();
  };

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- labelled, focusable role="group" with full keyboard handling (arrows scrub, Space plays)
    <div
      className={styles.strips}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable, keyboard-operated group
      tabIndex={0}
      role="group"
      aria-label="Telemetry strips: drag or arrow keys to scrub, Space to play or pause"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onLostPointerCapture={endGesture}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {specList.map(({ label: name, experimental }, i) => (
        <div key={name} ref={(el) => void (frames.current[i] = el)} className={styles.strip}>
          <div ref={(el) => void (hosts.current[i] = el)} className={styles.host} />
          <div aria-hidden="true" ref={(el) => void (playheads.current[i] = el)} className={styles.playhead} />
          {i === 0 && (
            <div className={styles.chips}>
              <ChipLayer annotations={annotations} distance={cmp.distance} h={handlers} layerRef={chipLayer} />
            </div>
          )}
          <div className={styles.label}>
            {name}
            {experimental && <span className={styles.exp} title="Experimental">exp</span>}
          </div>
          <div ref={(el) => void (values.current[i] = el)} className={styles.value} />
        </div>
      ))}
    </div>
  );
}
