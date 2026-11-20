import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { CompareResponse, TrackGeometry } from "../api/types";
import type { Annotation } from "../lib/annotations";
import { aidRuns, type AidRuns, type Run } from "../lib/driverAids";
import { BALANCE_HINT, balanceEnabled, balanceFromContract, type BalanceRuns } from "../lib/carBalance";
import { offTrackRuns } from "../lib/offTrack";
import { cleanGear, gearName, gearShifts, shiftLabel, thinShiftLabels, type Shift } from "../lib/gearShifts";
import { formatDelta } from "../lib/format";
import type { PlaybackModel } from "../lib/model";
import { distanceAtTime, formatSteering, indexAtTime, timeAtDistance } from "../lib/playback";
import { DEFAULT_WINDOW_M, WINDOW_WIDTH_KEY, chipLayerGeometry, clampWidth, cornerBands, cornerFitWidth, clipBand, distanceTicks, elevationRange, paddedRange, parseWidth, stripDistanceAt, stripPanCentre, stripRanges, symmetricRange, stripScrubTarget, stripView, wheelFactor, withAlpha, zoomWidth, type Range } from "../lib/strips";
import { usePlaybackStore } from "../state/playback";
import { colors, fonts } from "../theme";
import styles from "./DetailedStrips.module.css";
import * as Popover from "@radix-ui/react-popover";
import { loadStrips, moveStrip, saveStrips, STRIP_OPTIONS, toggleStrip, type StripId } from "../lib/stripChoice";
import { ChipLayer, type BadgeHandlers } from "./AnnotationOverlays";

const SYNC_KEY = "telemetry-strips";
const MIN_STRIP_H = 56;
const PAD_Y = 4;
const DRAG_THRESHOLD_PX = 4;
const STEP_M = 10;
const BIG_STEP_M = 100;
/** Keyboard zoom step (+ zooms in, − out). */
const KEY_ZOOM = 1.25;
const IGNORE_SELECTOR = "button,[data-annotation-badge]";

interface Gesture {
  pointerId: number;
  startX: number;
  startD: number;
  resume: boolean;
  dragging: boolean;
  /** Shift-drag or middle-drag: slide the traces and leave the playhead where it is. */
  pan: boolean;
  /** Centre of the window when the gesture began (pan only). */
  startCentre: number;
}

export interface DetailedStripsProps {
  model: PlaybackModel;
  /** The track's elevation (`api.trackGeometry`); the elevation strip shows when it has one. */
  geometry: TrackGeometry | null;
  annotations: Annotation[];
  handlers: BadgeHandlers;
  /** A corner the user just clicked (rail, badge, scrubber): the window fits it once; `n` changes on every click. The window then follows the playhead as before. */
  focusCorner?: { startM: number; endM: number; n: number } | null;
  /** Whether the lap is valid: wheels-off bands are red on an invalid lap, tan close calls on a valid one. Absent = valid. */
  lapValid?: boolean;
  /** Names in the legend and the read-outs' colour key, e.g. "You · L8" and "Comparison · ★L2". */
  youName?: string;
  refName?: string;
  /**
   * The replay stage of the one app (vroom-pnw.63): no panel borders, and the zoom, Choose strips and `viewControl`
   * (the Graphs / Wheel & pedals switch) sit in one "Strips" menu instead of the bar's loose controls.
   */
  stage?: { viewControl: ReactNode };
}

type Num = (number | null)[];
interface Spec {
  id: StripId;
  label: string;
  /** Marked "exp" next to the label. */
  experimental?: boolean;
  /** Tooltip on the label. */
  hint?: string;
  /** Always-visible note beside the label. */
  caption?: string;
  yRange: Range;
  data: Num[];
  series: uPlot.Series[];
  zeroLine?: boolean;
  deltaFill?: boolean;
  /** Driver aids and slip marks of this lap, drawn on the pedals strip (vroom-pnw.14). */
  aids?: { runs: AidRuns; throttle: number[]; brake: number[] };
  /** Where two or more wheels were off the track, as a band over the whole strip (vroom-pnw.24). */
  off: { runs: Run[]; color: string };
  /** Experimental under/oversteer marks of this lap on a trace (vroom-pnw.15), understeer always, oversteer only with `?balance` (from the API's runs). */
  balance?: { runs: BalanceRuns; values: Num };
  /** Where the comparison lap is stitched from another lap (the ideal lap's segment joins, vroom-bi4.3); a dashed line over the whole strip. Empty for a real lap. */
  joins: number[];
  /** Gear shifts of both laps, marked on the pedals strip (vroom-pnw.12). */
  shifts?: { lap: Shift[]; ref: Shift[] };
  /** Read-out at the playhead: this lap's value and, when the strip draws both laps, the comparison's (coloured like their lines). */
  value: (cmp: CompareResponse, tau: number, iy: number) => [string, string?];
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

function buildSpecs(cmp: CompareResponse, geometry: TrackGeometry | null, lapValid: boolean, balanceOn: boolean): Spec[] {
  const bal = balanceFromContract(cmp, balanceOn);
  const off = { runs: offTrackRuns(cmp.lap), color: lapValid ? colors.closeCall : colors.offTrack };
  const joins = cmp.ref_joins_m;
  const r = stripRanges(cmp);
  const gl = cleanGear(cmp.lap.gear);
  const gr = cleanGear(cmp.ref.gear);
  const refStroke = withAlpha(colors.comparison, 0.8);
  const specs: Spec[] = [
    {
      id: "speed", label: "SPEED", off, joins, yRange: r.speed,
      data: [cmp.ref.speed_kmh, cmp.lap.speed_kmh],
      series: [line(refStroke, 1.2), line(colors.you, 1.6)],
      value: (c, tau, iy) => [`${Math.round(c.lap.speed_kmh[iy])}`, `${Math.round(c.ref.speed_kmh[indexAtTime(c.ref.t, tau)])}`],
    },
    {
      id: "pedals", label: "BRAKE & THROTTLE", off, joins, yRange: r.pedals,
      data: [cmp.ref.throttle, cmp.ref.brake, cmp.lap.throttle, cmp.lap.brake],
      series: [
        line(withAlpha(colors.throttle, 0.45), 1.2), line(withAlpha(colors.brake, 0.45), 1.2),
        line(colors.throttle, 1.6), line(colors.brake, 1.6),
      ],
      aids: { runs: aidRuns(cmp.lap), throttle: cmp.lap.throttle, brake: cmp.lap.brake },
      shifts: { lap: gearShifts(cmp.lap.gear), ref: gearShifts(cmp.ref.gear) },
      value: (c, _t, iy) => [`${Math.round(c.lap.throttle[iy] * 100)}% · ${Math.round(c.lap.brake[iy] * 100)}%`
        + (c.lap.abs[iy] ? " · ABS" : "") + (c.lap.tc[iy] ? " · TC" : "")],
    },
    {
      id: "gear", label: "GEAR", off, joins, yRange: gearRange(gl, gr),
      data: [gr, gl],
      series: [stepLine(refStroke, 1.2), stepLine(colors.you, 1.6)],
      value: (c, tau, iy) => [gearName(gl[iy]), gearName(gr[indexAtTime(c.ref.t, tau)] ?? 0)],
    },
    {
      // Plotted on the normalised scale so both cars share one axis; the label uses steeringDisplay units.
      id: "steering", label: "STEERING", off, joins, yRange: r.steering,
      data: [cmp.ref.steering, cmp.lap.steering],
      series: [line(refStroke, 1.2), line(colors.you, 1.6)],
      // The steering strip carries the understeer marks; with ?balance also the experimental oversteer ones, and says so.
      ...(bal ? { balance: { runs: bal.runs, values: cmp.lap.steering }, hint: BALANCE_HINT, ...(balanceOn ? { experimental: true } : {}) } : {}),
      value: (c, _t, iy) => [formatSteering(c.lap.steering[iy], c.lap_steering_range_deg)],
    },
    {
      id: "delta", label: "TIME VS BEST", hint: "Rising = losing time. Falling = gaining time.", caption: "rising = losing time", off, joins, yRange: r.delta,
      data: [cmp.delta],
      series: [line(colors.textSoft, 1.6)],
      zeroLine: true, deltaFill: true,
      value: (c, _t, iy) => [`${formatDelta(c.delta[iy])} s`],
    },
  ];
  const track = geometry?.elevation_m;
  if (track) {
    // Game world height from a shared-memory capture (#94), a property of the track so one line for both laps; in metres.
    const n = cmp.distance.length;
    const e = Array.from({ length: n }, (_, i) => track[i] ?? null);
    const m = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toFixed(1));
    specs.push({
      id: "elevation", label: "ELEVATION", off, joins, experimental: true, yRange: elevationRange(e),
      data: [e],
      series: [line(colors.textSoft, 1.6)],
      value: (_c, _t, iy) => [`${m(e[iy])} m`],
    });
  }
  const { lap, ref } = cmp;
  const dimmer = (c: string) => withAlpha(c, 0.45);
  const wheels = ["FL", "FR", "RL", "RR"] as const;
  const wheelColors = [colors.you, colors.strength, colors.minor, colors.issue];
  const wheelValues = (a: number[][], iy: number, digits: number) => a.map((w, k) => `${wheels[k]} ${w[iy].toFixed(digits)}`).join(" ");
  const susp = [lap.susp_fl, lap.susp_fr, lap.susp_rl, lap.susp_rr];
  const slip = [lap.slip_fl, lap.slip_fr, lap.slip_rl, lap.slip_rr];
  specs.push(
    {
      id: "rpm", label: "RPM", off, joins, yRange: paddedRange(0.05, 1000, lap.rpm, ref.rpm),
      data: [ref.rpm, lap.rpm], series: [line(refStroke, 1.2), line(colors.you, 1.6)],
      value: (c, tau, iy) => [`${Math.round(c.lap.rpm[iy])}`, `${Math.round(c.ref.rpm[indexAtTime(c.ref.t, tau)])}`],
    },
    {
      id: "g_lat", label: "CORNERING FORCE", off, joins, yRange: symmetricRange(0.5, lap.g_lat, ref.g_lat), zeroLine: true,
      data: [ref.g_lat, lap.g_lat], series: [line(refStroke, 1.2), line(colors.you, 1.6)],
      value: (c, tau, iy) => [c.lap.g_lat[iy].toFixed(2), c.ref.g_lat[indexAtTime(c.ref.t, tau)].toFixed(2)],
    },
    {
      id: "g_long", label: "BRAKING & ACCELERATION FORCE", off, joins, yRange: symmetricRange(0.5, lap.g_long, ref.g_long), zeroLine: true,
      data: [ref.g_long, lap.g_long], series: [line(refStroke, 1.2), line(colors.you, 1.6)],
      value: (c, tau, iy) => [c.lap.g_long[iy].toFixed(2), c.ref.g_long[indexAtTime(c.ref.t, tau)].toFixed(2)],
    },
    {
      // This lap only: four wheels already fill the strip.
      id: "suspension", label: "SUSPENSION", off, joins, yRange: paddedRange(0.05, 0.01, ...susp),
      data: susp, series: wheelColors.map((c) => line(dimmer(c), 1.4)),
      value: (_c, _t, iy) => [wheelValues(susp, iy, 3)],
    },
    {
      id: "slip", label: "WHEEL SLIP", off, joins, yRange: paddedRange(0.05, 0.4, ...slip, [1]),
      data: slip, series: wheelColors.map((c) => line(dimmer(c), 1.4)),
      value: (_c, _t, iy) => [wheelValues(slip, iy, 2)],
    },
  );
  if (bal) {
    // Yaw rate the steering asks for minus the path's, deg/s; > 0 understeer, < 0 oversteer (experimental), from the API.
    const lapB = bal.balance;
    const refB = bal.ref ?? lapB.map(() => null);
    const finite = (v: Num) => v.filter((x): x is number => x !== null);
    const word = (b: number | null) => (b === null ? "–" : `${b > 0 ? "US" : "OS"} ${Math.abs(b).toFixed(1)}`);
    specs.push({
      id: "balance", label: "BALANCE (US + / OS −, °/s)", off, joins, experimental: true, hint: BALANCE_HINT, zeroLine: true,
      // Capped: a spin or a kerb strike reads 40+ deg/s and would flatten the rest.
      yRange: ((m) => [-m, m] as Range)(Math.min(BALANCE_MAX_DEG_S, symmetricRange(2, finite(lapB), finite(refB))[1])),
      data: [refB, lapB], series: [line(refStroke, 1.2), line(colors.you, 1.6)],
      balance: { runs: bal.runs, values: lapB },
      value: (c, tau, iy) => [word(lapB[iy]), word(refB[indexAtTime(c.ref.t, tau)])],
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

/** Dashed lines where the comparison lap is stitched from another lap (the ideal lap's segment joins): speed and line can jump there. */
function drawJoins(u: uPlot, joins: number[]) {
  if (!joins.length) return;
  const { ctx, bbox } = u;
  const sx = u.scales.x;
  const xs = u.data[0];
  const lo = sx.min ?? xs[0], hi = sx.max ?? xs[xs.length - 1];
  const dpr = uPlot.pxRatio;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  ctx.strokeStyle = withAlpha(colors.ideal, 0.75);
  ctx.lineWidth = dpr;
  ctx.setLineDash([4 * dpr, 3 * dpr]);
  for (const m of joins) {
    if (m < lo || m > hi) continue;
    const x = Math.round(bbox.left + u.valToPos(m, "x", true)) + dpr / 2;
    ctx.beginPath();
    ctx.moveTo(x, bbox.top);
    ctx.lineTo(x, bbox.top + bbox.height);
    ctx.stroke();
  }
  ctx.restore();
}

/** A faint band over the full height of a strip where wheels were off the track, with a solid edge line at its start so a short one still shows. */
function drawOffTrack(u: uPlot, runs: Run[], color: string) {
  const { ctx, bbox } = u;
  const xs = u.data[0];
  const sx = u.scales.x;
  const lo = sx.min ?? xs[0], hi = sx.max ?? xs[xs.length - 1];
  const px = (i: number) => bbox.left + u.valToPos(xs[i], "x", true);
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  for (const r of runs) {
    if (xs[r.end] < lo || xs[r.start] > hi) continue;
    const x0 = px(r.start), x1 = Math.max(px(Math.min(r.end + 1, xs.length - 1)), x0 + uPlot.pxRatio);
    ctx.fillStyle = withAlpha(color, OFF_BAND_ALPHA);
    ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height);
    ctx.fillStyle = withAlpha(color, 0.9);
    ctx.fillRect(x0, bbox.top, uPlot.pxRatio * 2, bbox.height);
  }
  ctx.restore();
}

const AID_BAND_ALPHA = 0.22;
const OFF_BAND_ALPHA = 0.18;
const MARK_PX = 3;
const BALANCE_MAX_DEG_S = 25;

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
function drawSlipMarks(u: uPlot, runs: Run[], values: Num, color: string) {
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
      ctx.moveTo(px(r.start), bbox.top + u.valToPos(values[r.start] ?? 0, "y", true));
      // A one-metre run is a dot (a zero-length line with round caps).
      if (r.end === r.start) ctx.lineTo(px(r.start) + 0.01, bbox.top + u.valToPos(values[r.start] ?? 0, "y", true));
      for (let i = r.start + 1; i <= r.end; i++) ctx.lineTo(px(i), bbox.top + u.valToPos(values[i] ?? 0, "y", true));
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
  ctx.font = `${11 * dpr}px ${fonts.mono}`;
  ctx.textBaseline = "top";
  // The lap's markers sit at the top, the comparison lap's on a second row below, so labels of the two do not overlap.
  const y0 = bbox.top + row * 12 * dpr;
  const vis: { s: Shift; x: number }[] = [];
  for (const s of shifts) {
    const m = xs[s.i];
    if (m < lo - 5 || m > hi + 5) continue;
    vis.push({ s, x: bbox.left + u.valToPos(m, "x", true) });
  }
  // Ticks for every shift; labels only where they do not run into the previous one.
  const labelX = vis.map((v) => v.x + 2 * dpr);
  const widths = vis.map((v) => ctx.measureText(shiftLabel(v.s)).width);
  const keep = thinShiftLabels(labelX, widths, 3 * dpr);
  vis.forEach((v, k) => {
    ctx.fillRect(v.x - dpr / 2, y0, dpr, SHIFT_TICK_PX * dpr);
    if (keep[k]) ctx.fillText(shiftLabel(v.s), labelX[k], y0 + dpr);
  });
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

function loadWidth(): number {
  try { return parseWidth(localStorage.getItem(WINDOW_WIDTH_KEY)); } catch { return DEFAULT_WINDOW_M; }
}

/** Distance ticks under the last strip, pooled spans moved on each window change. Tick x matches the plot, which spans the axis's full width. */
function drawAxis(el: HTMLDivElement | null, min: number, max: number) {
  if (!el) return;
  const ticks = distanceTicks(min, max);
  while (el.children.length > ticks.length + 1) el.lastElementChild!.remove();
  while (el.children.length < ticks.length + 1) el.append(document.createElement("span"));
  const unit = el.firstElementChild as HTMLElement;
  unit.textContent = "m";
  unit.className = styles.axisUnit;
  ticks.forEach((m, i) => {
    const t = el.children[i + 1] as HTMLElement;
    t.className = styles.tick;
    t.textContent = String(m);
    t.style.left = `${(((m - min) / (max - min || 1)) * 100).toFixed(3)}%`;
  });
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
          drawOffTrack(u, spec.off.runs, spec.off.color);
          drawJoins(u, spec.joins);
          if (spec.zeroLine || spec.deltaFill) drawDelta(u, !!spec.zeroLine, !!spec.deltaFill);
          if (spec.aids) {
            drawAidBands(u, spec.aids.runs.abs, spec.aids.brake, colors.brake);
            drawAidBands(u, spec.aids.runs.tc, spec.aids.throttle, colors.throttle);
          }
        },
      ],
      draw: [
        (u) => {
          if (spec.balance) {
            drawSlipMarks(u, spec.balance.runs.understeer, spec.balance.values, colors.understeer);
            drawSlipMarks(u, spec.balance.runs.oversteer, spec.balance.values, colors.oversteer);
          }
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

function StripPickerLists({ choice: stored, available, onChange }: { choice: StripId[]; available: StripId[]; onChange: (next: StripId[]) => void }) {
  // A stored strip the data cannot draw (elevation on a flat track) stays stored but is not listed; edits keep it at the end.
  const choice = stored.filter((id) => available.includes(id));
  const hidden = stored.filter((id) => !available.includes(id));
  const change = (next: StripId[]) => onChange([...next, ...hidden]);
  const rest = STRIP_OPTIONS.filter((o) => available.includes(o.id) && !choice.includes(o.id));
  const label = (id: StripId) => STRIP_OPTIONS.find((o) => o.id === id)!.label;
  return (
    <>
      <ul className={styles.pickerList} aria-label="Shown strips">
        {choice.map((id, i) => (
          <li key={id} className={styles.pickerRow}>
            <span className={styles.pickerName}>{label(id)}<span className={styles.pickerDesc}>{STRIP_OPTIONS.find((o) => o.id === id)!.desc}</span></span>
            <button type="button" aria-label={`Move ${label(id)} up`} disabled={i === 0} onClick={() => change(moveStrip(choice, id, -1))}>↑</button>
            <button type="button" aria-label={`Move ${label(id)} down`} disabled={i === choice.length - 1} onClick={() => change(moveStrip(choice, id, 1))}>↓</button>
            <button type="button" aria-label={`Remove ${label(id)}`} disabled={choice.length === 1} onClick={() => change(toggleStrip(choice, id))}>×</button>
          </li>
        ))}
      </ul>
      {(["basics", "advanced"] as const).map((g) => {
        const items = rest.filter((o) => o.group === g);
        if (items.length === 0) return null;
        return (
          <ul key={g} className={styles.pickerList} aria-label={g === "basics" ? "Basics" : "Advanced"}>
            <li className={styles.pickerGroup}>{g === "basics" ? "Basics" : "Advanced"}</li>
            {items.map((o) => (
              <li key={o.id} className={styles.pickerRow}>
                <span className={styles.pickerName}>{o.label}<span className={styles.pickerDesc}>{o.desc}</span></span>
                <button type="button" aria-label={`Add ${o.label}`} onClick={() => change(toggleStrip(choice, o.id))}>+</button>
              </li>
            ))}
          </ul>
        );
      })}
    </>
  );
}

function StripPicker(p: { choice: StripId[]; available: StripId[]; onChange: (next: StripId[]) => void }) {
  return (
    <div className={styles.pickerBar}>
      <Popover.Root>
        <Popover.Trigger className={styles.pickerButton} aria-label="Choose strips">Choose strips</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className={styles.picker} align="end" sideOffset={4} aria-label="Choose strips">
            <StripPickerLists {...p} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

/** The stage's one strip menu: the view switch, the zoom window and the strip choice. */
export function StripMenu({ viewControl, zoom, picker }: { viewControl: ReactNode; zoom?: ReactNode; picker?: ReactNode }) {
  return (
    <div className={styles.pickerBar}>
      <Popover.Root>
        <Popover.Trigger className={styles.pickerButton} aria-label="Strip menu" title="View, zoom and which strips to show">Strips ▾</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className={styles.picker} align="end" sideOffset={4} collisionPadding={8} aria-label="Strip menu">
            <div className={styles.menuSection}>{viewControl}</div>
            {zoom}
            {picker}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

/**
 * Five uPlot strips (six when the track has an elevation capture). React renders this once per comparison / annotation set. Per frame, an effect subscribed to
 * the playback store moves each chart's x scale synchronously, the chip layer and the value read-outs imperatively.
 */
export function DetailedStrips({ model, geometry, annotations, handlers, focusCorner = null, lapValid = true, youName = "You", refName = "Compared with", stage }: DetailedStripsProps) {
  const store = usePlaybackStore();
  const { cmp } = model;
  const [choice, setChoice] = useState<StripId[]>(() => loadStrips());
  const balanceOn = useMemo(() => balanceEnabled(globalThis.location?.search ?? ""), []);
  const allSpecs = useMemo(() => buildSpecs(cmp, geometry, lapValid, balanceOn), [cmp, geometry, lapValid, balanceOn]);
  // The chosen strips in the chosen order; one the data cannot draw (elevation on a flat track) is skipped.
  const aidKey = useMemo(() => {
    const a = allSpecs.find((x) => x.id === "pedals")?.aids?.runs;
    return a && (a.abs.length > 0 || a.tc.length > 0) ? { abs: a.abs.length > 0, tc: a.tc.length > 0 } : null;
  }, [allSpecs]);
  const specList = useMemo(() => {
    const picked = choice.flatMap((id) => allSpecs.filter((s) => s.id === id));
    return picked.length > 0 ? picked : allSpecs.slice(0, 1);
  }, [choice, allSpecs]);
  const changeChoice = (next: StripId[]) => { setChoice(next); saveStrips(next); };
  const [width, setWidth] = useState(loadWidth);
  // The width and the pan the effect reads each frame; changing either re-applies at once through `reapply`.
  const widthRef = useRef(width);
  /** Window centre after a pan; null while the window follows the playhead. Cleared by the next playhead move. */
  const panRef = useRef<number | null>(null);
  const reapply = useRef<() => void>(() => {});
  const axis = useRef<HTMLDivElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const lapSpan = () => (cmp.distance[cmp.distance.length - 1] ?? 0) - (cmp.distance[0] ?? 0);
  /** Set the window width (clamped to 100 m..the whole lap); `keep` stores it as the user's choice. */
  const applyWidth = (next: number, keep = true) => {
    const w = clampWidth(next, lapSpan());
    widthRef.current = w;
    setWidth(w);
    if (keep) { try { localStorage.setItem(WINDOW_WIDTH_KEY, String(Math.round(w))); } catch { /* storage unavailable */ } }
    reapply.current();
  };
  const applyWidthRef = useRef(applyWidth);
  useLayoutEffect(() => { applyWidthRef.current = applyWidth; });
  // A click on a corner elsewhere fits it once (not stored); the playhead's next move brings the follow window back at that width.
  const lastFocus = useRef(focusCorner?.n ?? 0);
  useEffect(() => {
    if (!focusCorner || focusCorner.n === lastFocus.current) return;
    lastFocus.current = focusCorner.n;
    const xs = cmp.distance;
    const d = distanceAtTime(cmp.lap.t, xs, store.get().tau);
    applyWidthRef.current(cornerFitWidth({ startM: focusCorner.startM, endM: focusCorner.endM }, d, xs[xs.length - 1] ?? 0, lapSpan()), false);
  // fires per click (`n`), not per render
  }, [focusCorner?.n]);
  const hosts = useRef<(HTMLDivElement | null)[]>([]);
  const frames = useRef<(HTMLDivElement | null)[]>([]);
  const values = useRef<(HTMLDivElement | null)[]>([]);
  const playheads = useRef<(HTMLDivElement | null)[]>([]);
  /** The x window currently shown (metres); clicks map through it. */
  const shown = useRef({ min: 0, max: DEFAULT_WINDOW_M });
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
    const apply = (force = false) => {
      const tau = store.get().tau;
      if (tau === lastTau && !force) return;
      // oxlint-disable-next-line react/immutability -- local of this effect's own closure, not render state
      // A playhead move (drag, click, playback, keys) ends a pan: the window follows the playhead again.
      if (tau !== lastTau) panRef.current = null;
      lastTau = tau;
      const d = distanceAtTime(cmp.lap.t, xs, tau);
      // Clamped to the lap: near the start or end the window stops and the playhead line moves off centre instead.
      const win = stripView(widthRef.current, d, dMin, dMax, panRef.current);
      lastMin = win.min;
      lastMax = win.max;
      shown.current = { min: win.min, max: win.max };
      for (const u of us) u.setScale("x", { min: lastMin, max: lastMax });
      const left = `${(win.playhead * 100).toFixed(3)}%`;
      for (const el of playheads.current) if (el) { el.style.left = left; el.style.visibility = win.playhead < 0 || win.playhead > 1 ? "hidden" : "visible"; }
      placeChips();
      drawAxis(axis.current, lastMin, lastMax);
      const iy = indexAtTime(cmp.lap.t, tau);
      specs.forEach((s, i) => {
        const el = values.current[i];
        if (!el) return;
        const [lap, ref] = s.value(cmp, tau, iy);
        const [a, b, c] = Array.from(el.children);
        if (!a) return;
        a.textContent = lap;
        b.textContent = ref === undefined ? "" : " / ";
        c.textContent = ref ?? "";
        el.toggleAttribute("data-pair", ref !== undefined);
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

    const unsub = store.subscribe(() => apply());
    apply();
    reapply.current = () => apply(true);

    return () => {
      unsub();
      reapply.current = () => {};
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
    const pan = e.button === 1 || (e.button === 0 && e.shiftKey);
    if ((e.button !== 0 && e.button !== 1) || gesture.current || foreign(e)) return;
    // Middle button: no browser autoscroll.
    if (e.button === 1) e.preventDefault();
    gesture.current = {
      pointerId: e.pointerId, startX: e.clientX, startD: centreM(), resume: store.get().playing, dragging: false,
      pan, startCentre: (shown.current.min + shown.current.max) / 2,
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
    const { min, max } = shown.current;
    if (g.pan) {
      // The traces slide with the pointer; the playhead (and so the map, read-outs and 3D view) stays put.
      panRef.current = stripPanCentre(g.startCentre, dx, plotWidth(), widthRef.current, lo, hi);
      reapply.current();
      return;
    }
    // The window follows the playhead: the trace follows the pointer, so dragging left goes forward. The whole lap
    // cannot scroll, so there the playhead goes where the pointer goes.
    const whole = widthRef.current >= hi - lo;
    store.seek(timeAtDistance(cmp.lap.t, cmp.distance, stripScrubTarget(g.startD, whole ? -dx : dx, plotWidth(), (max - min) / 2, lo, hi)));
  };

  const endGesture = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    e.currentTarget.removeAttribute("data-dragging");
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (g.dragging) {
      wasDrag.current = true;
      // A pan holds the view, and playback would pull it straight back: stay paused.
      if (g.resume && !g.pan) store.play();
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
      // Double-click: back to the default width, following the playhead.
      panRef.current = null;
      applyWidth(DEFAULT_WINDOW_M);
    }
  };

  // Wheel and trackpad pinch (ctrl+wheel) zoom the window width. A native listener, because React's wheel handler is passive and cannot stop the page scrolling.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element | null)?.closest?.(IGNORE_SELECTOR) || e.deltaY === 0) return;
      e.preventDefault();
      applyWidthRef.current(zoomWidth(widthRef.current, wheelFactor(e.deltaY, e.ctrlKey), lapSpan()));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  // reads the lap through refs and the latest closure
  }, [cmp]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === " ") {
      store.toggle();
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const step = (e.shiftKey ? BIG_STEP_M : STEP_M) * (e.key === "ArrowRight" ? 1 : -1);
      seekToDistance(centreM() + step);
    } else if (e.key === "+" || e.key === "=") {
      applyWidth(widthRef.current / KEY_ZOOM);
    } else if (e.key === "-" || e.key === "_") {
      applyWidth(widthRef.current * KEY_ZOOM);
    } else {
      return;
    }
    e.preventDefault();
  };

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- labelled, focusable role="group" with full keyboard handling (arrows scrub, Space plays)
    <div
      ref={root}
      className={styles.strips}
      data-flat={stage ? "" : undefined}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable, keyboard-operated group
      tabIndex={0}
      role="group"
      aria-label="Telemetry strips: drag or arrow keys to move along the lap, Shift-drag to slide the view, wheel or plus and minus to zoom, Space to play or pause"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onLostPointerCapture={endGesture}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <div className={styles.bar}>
        <div className={styles.legend} aria-label="Legend">
          <span className={styles.legendItem}><i className={styles.swatch} style={{ background: colors.you }} />{youName}</span>
          <span className={styles.legendItem}><i className={styles.swatch} style={{ background: colors.comparison }} />{refName}</span>
        </div>
        {stage ? (
          <StripMenu
            viewControl={stage.viewControl}
            zoom={
              <div className={styles.menuSection} role="group" aria-label="Zoom">
                <span className={styles.pickerGroup}>Zoom · {width >= lapSpan() ? "whole lap" : `${Math.round(width)} m`}</span>
                <span className={styles.pickerDesc}>Scroll over the strips to zoom, drag to move.</span>
                <div className={styles.zoomRow}>
                  <button type="button" onClick={() => { panRef.current = null; applyWidth(DEFAULT_WINDOW_M); }}>Reset to {DEFAULT_WINDOW_M} m</button>
                  <button type="button" onClick={() => { panRef.current = null; applyWidth(lapSpan()); }}>Whole lap</button>
                </div>
              </div>
            }
            picker={<StripPickerLists choice={choice} available={allSpecs.map((x) => x.id)} onChange={changeChoice} />}
          />
        ) : (
          <>
            <div className={styles.windowGroup}>
              <span className={styles.hint}>Drag to move along the lap · scroll to zoom</span>
              <button type="button" className={styles.windowButton} title="Window width: click to reset to 700 m (double-clicking the strips does the same)" onClick={() => { panRef.current = null; applyWidth(DEFAULT_WINDOW_M); }}>
                {width >= lapSpan() ? "Whole lap" : `Zoom: ${Math.round(width)} m`}
              </button>
            </div>
            <StripPicker choice={choice} available={allSpecs.map((x) => x.id)} onChange={changeChoice} />
          </>
        )}
      </div>
      {specList.map(({ id, label: name, experimental, hint, caption }, i) => (
        <div key={id} className={styles.strip}>
          <div className={styles.header}>
            <div className={styles.label} title={hint}>
              {name}
              {experimental && <span className={styles.exp} title="Experimental">exp</span>}
              {caption && <span className={styles.caption}>{caption}</span>}
            </div>
            {id === "pedals" && aidKey && (
              <span className={styles.aidKey} title="Light shading under the traces: ABS where the brake trace is shaded, traction control (TC) where the throttle trace is shaded. Your lap only.">
                {aidKey.abs && <span className={styles.aidItem}><i className={styles.aidSwatch} style={{ background: withAlpha(colors.brake, 0.6) }} />ABS</span>}
                {aidKey.tc && <span className={styles.aidItem}><i className={styles.aidSwatch} style={{ background: withAlpha(colors.throttle, 0.6) }} />TC</span>}
              </span>
            )}
            <div ref={(el) => void (values.current[i] = el)} className={styles.value}>
              <span className={styles.vLap} /><span /><span className={styles.vRef} />
            </div>
          </div>
          <div ref={(el) => void (frames.current[i] = el)} className={styles.plot}>
            <div ref={(el) => void (hosts.current[i] = el)} className={styles.host} />
            <div aria-hidden="true" ref={(el) => void (playheads.current[i] = el)} className={styles.playhead} />
            {i === 0 && (
              <div className={styles.chips}>
                <ChipLayer annotations={annotations} distance={cmp.distance} h={handlers} layerRef={chipLayer} />
              </div>
            )}
          </div>
        </div>
      ))}
      <div ref={axis} className={styles.axis} aria-hidden="true"><span /></div>
    </div>
  );
}
