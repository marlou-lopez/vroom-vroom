import { splitWrapping } from "./trackmap";
// Pure helpers for the uPlot telemetry strips: fixed y ranges, chip-layer geometry, band clipping, colour alpha.

export type Range = [number, number];

export interface StripRanges {
  speed: Range;
  pedals: Range;
  steering: Range;
  delta: Range;
}

export interface RangeInput {
  lap: { speed_kmh: ArrayLike<number>; steering: ArrayLike<number> };
  ref: { speed_kmh: ArrayLike<number>; steering: ArrayLike<number> };
  delta: ArrayLike<number>;
}

function minMax(...arrs: ArrayLike<number>[]): Range | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const a of arrs) {
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return Number.isFinite(lo) ? [lo, hi] : null;
}

const maxAbs = (...arrs: ArrayLike<number>[]): number => {
  const r = minMax(...arrs);
  return r ? Math.max(Math.abs(r[0]), Math.abs(r[1])) : 0;
};

/** Smallest half-range used for the symmetric strips, so a flat channel does not collapse the axis. */
export const MIN_HALF_RANGE = 0.05;

/** Y ranges fixed for a whole comparison, so nothing rescales while the window scrolls. */
export function stripRanges(c: RangeInput): StripRanges {
  const sp = minMax(c.lap.speed_kmh, c.ref.speed_kmh) ?? [0, 300];
  const steer = Math.max(maxAbs(c.lap.steering, c.ref.steering) * 1.05, MIN_HALF_RANGE);
  const dm = Math.max(maxAbs(c.delta) * 1.1, MIN_HALF_RANGE);
  return { speed: [sp[0] - 5, sp[1] + 5], pedals: [-0.05, 1.05], steering: [-steer, steer], delta: [-dm, dm] };
}

/** Linear value-to-pixel map for an x scale `[min, max]` shown over `width` px starting at `left`. */
export function valueToPx(v: number, min: number, max: number, width: number, left = 0): number {
  return left + ((v - min) / (max - min || 1)) * width;
}

export interface ChipLayerGeometry {
  /** Total width (px) of the layer holding every chip: the whole lap at the current zoom. */
  widthPx: number;
  /** translateX (px) that puts distance `dataMin` where the scale puts it. */
  offsetPx: number;
}

/** Geometry of the wide chip layer for the current x scale. Chips sit at `(m - dataMin) / (dataMax - dataMin)` of the layer. */
export function chipLayerGeometry(
  scaleMin: number, scaleMax: number, plotWidth: number, plotLeft: number, dataMin: number, dataMax: number,
): ChipLayerGeometry {
  const pxPerM = plotWidth / (scaleMax - scaleMin || 1);
  return { widthPx: (dataMax - dataMin) * pxPerM, offsetPx: valueToPx(dataMin, scaleMin, scaleMax, plotWidth, plotLeft) };
}

/** Left position of a chip as a fraction (0..1) of the chip layer. */
export function chipFraction(m: number, dataMin: number, dataMax: number): number {
  return (m - dataMin) / (dataMax - dataMin || 1);
}

/** Clip a band `[x0, x1]` (px) to the plot area `[left, left + width]`; null when nothing is visible. */
export function clipBand(x0: number, x1: number, left: number, width: number): [number, number] | null {
  const a = Math.max(left, Math.min(x0, x1));
  const b = Math.min(left + width, Math.max(x0, x1));
  return b > a ? [a, b] : null;
}

/** `#RRGGBB` plus an alpha 0..1 as `#RRGGBBAA`. */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return `${hex}${a.toString(16).padStart(2, "0")}`;
}

/** Distance shown at pixel `px` of a strip `widthPx` wide whose window is `[centreM - halfM, centreM + halfM]`. */
export function stripDistanceAt(px: number, widthPx: number, centreM: number, halfM: number): number {
  if (widthPx <= 0) return centreM;
  return centreM - halfM + (px / widthPx) * 2 * halfM;
}

/** Playhead distance after dragging the trace by `dxPx` from `startM`: the trace follows the pointer, so dragging left goes forward. */
export function stripScrubTarget(
  startM: number, dxPx: number, widthPx: number, halfM: number, minM: number, maxM: number,
): number {
  if (widthPx <= 0) return startM;
  return Math.min(Math.max(startM - dxPx * ((2 * halfM) / widthPx), minM), maxM);
}

/**
 * The strips' x window: 2·halfM metres centred on the playhead `d`, but clamped to the lap [minM, maxM] so it never
 * shows empty space before the start or after the end. `playhead` is where `d` sits in the window (0..1).
 */
export function stripWindow(d: number, halfM: number, minM: number, maxM: number): { min: number; max: number; playhead: number } {
  const span = 2 * halfM;
  const min = Math.max(minM, Math.min(d - halfM, maxM - span));
  return { min, max: min + span, playhead: (d - min) / span };
}

/** Fixed y range for the elevation strip: the heights (nulls ignored; one or more arrays) with 5 % padding and at least 10 m of span. */
export function elevationRange(...heights: ArrayLike<number | null>[]): Range {
  let lo = Infinity;
  let hi = -Infinity;
  for (const a of heights) {
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (v === null || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo)) return [-5, 5];
  const pad = Math.max((hi - lo) * 0.05, (10 - (hi - lo)) / 2, 0);
  return [lo - pad, hi + pad];
}

/** The bands to shade for a corner (two when it wraps over the start line), and which ends are the corner's real edges. */
export function cornerBands(startM: number, endM: number, lapEnd: number): Array<{ d0: number; d1: number; startEdge: boolean; endEdge: boolean }> {
  return splitWrapping(startM, endM, lapEnd).map(([d0, d1]) => ({ d0, d1, startEdge: d0 === startM, endEdge: d1 === endM }));
}

/** Fixed y range over arrays: their min and max with `padFrac` of the span either side; at least `minSpan` wide. */
export function paddedRange(padFrac: number, minSpan: number, ...arrs: ArrayLike<number>[]): Range {
  const r = minMax(...arrs);
  if (!r) return [0, minSpan];
  const mid = (r[0] + r[1]) / 2;
  const half = Math.max((r[1] - r[0]) * (0.5 + padFrac), minSpan / 2);
  return [mid - half, mid + half];
}

/** Symmetric y range around zero over arrays: 5 % headroom, at least `minHalf`. */
export function symmetricRange(minHalf: number, ...arrs: ArrayLike<number>[]): Range {
  const m = Math.max(maxAbs(...arrs) * 1.05, minHalf);
  return [-m, m];
}

// ---- Window: follows the playhead, zoom sets only its width (vroom-pnw.48) ----

export const WINDOW_WIDTH_KEY = "vroom.stripWidth";
/** Default window width (m), and the narrowest zoom. */
export const DEFAULT_WINDOW_M = 700;
export const MIN_WINDOW_M = 100;
/** Corner fit: padding as a fraction of the corner's length, at least `CORNER_MIN_PAD_M` either side, and a floor on the half-window. */
export const CORNER_PAD_FRAC = 0.25;
export const CORNER_MIN_PAD_M = 40;
export const CORNER_MIN_HALF_M = 60;

export interface CornerSpan { startM: number; endM: number }
export interface StripView { min: number; max: number; playhead: number }

/** A window width kept between `MIN_WINDOW_M` and the whole lap (`lapSpan` m); a lap shorter than the minimum is always shown whole. */
export function clampWidth(width: number, lapSpan: number): number {
  const w = Number.isFinite(width) ? width : DEFAULT_WINDOW_M;
  return Math.min(Math.max(w, MIN_WINDOW_M), Math.max(lapSpan, 1));
}

/** A stored window width: a finite number of at least `MIN_WINDOW_M`, else the default. */
export function parseWidth(v: unknown): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= MIN_WINDOW_M ? n : DEFAULT_WINDOW_M;
}

/** The width after a zoom step: `factor` > 1 zooms out (wider), < 1 zooms in. */
export function zoomWidth(width: number, factor: number, lapSpan: number): number {
  return clampWidth(width * factor, lapSpan);
}

/** Zoom factor for a wheel event: continuous, wheel down (deltaY > 0) zooms out; a pinch (ctrlKey) sends smaller deltas. */
export function wheelFactor(deltaY: number, pinch: boolean): number {
  return Math.exp(Math.max(-100, Math.min(100, deltaY)) * (pinch ? 0.01 : 0.0015));
}

/** Window centre after panning the trace by `dxPx` from `startCentre`: the trace follows the pointer. Kept inside the lap. */
export function stripPanCentre(startCentre: number, dxPx: number, plotPx: number, width: number, minM: number, maxM: number): number {
  if (plotPx <= 0) return startCentre;
  const half = Math.min(width, maxM - minM) / 2;
  return Math.min(Math.max(startCentre - dxPx * (width / plotPx), minM + half), maxM - half);
}

/** Centre and half-width (m) of a window fitted to a corner with padding; a corner over the start line fits the half that holds `d` (else the first half). */
export function fitCorner(c: CornerSpan, d: number, lapEnd: number): { centre: number; half: number } {
  const bands = splitWrapping(c.startM, c.endM, lapEnd);
  const [a, b] = bands.find(([x, y]) => d >= x && d <= y) ?? bands[0];
  const pad = Math.max((b - a) * CORNER_PAD_FRAC, CORNER_MIN_PAD_M);
  return { centre: (a + b) / 2, half: Math.max((b - a) / 2 + pad, CORNER_MIN_HALF_M) };
}

/** Window width that shows the whole corner when the window is centred on the playhead `d` (a click seeks a little before the corner). */
export function cornerFitWidth(c: CornerSpan, d: number, lapEnd: number, lapSpan: number): number {
  const { centre, half } = fitCorner(c, d, lapEnd);
  return clampWidth(2 * (Math.abs(centre - d) + half), lapSpan);
}

/**
 * The x window: `width` metres around the playhead `d`, or around `panCentre` after a Shift-drag pan (null: follow the playhead).
 * Clamped to the lap; at the whole lap it does not move and only the playhead does. `playhead` is where `d` sits in the window
 * and lies outside 0..1 when a pan has moved the window away from it.
 */
export function stripView(width: number, d: number, minM: number, maxM: number, panCentre: number | null = null): StripView {
  const span = maxM - minM || 1;
  const w = clampWidth(width, span);
  if (w >= span) return { min: minM, max: maxM, playhead: (d - minM) / span };
  const win = stripWindow(panCentre ?? d, w / 2, minM, maxM);
  return { min: win.min, max: win.max, playhead: (d - win.min) / w };
}

/** Tick positions (whole metres, 1/2/5 × 10^k steps) inside `[min, max]`, about `target` of them. */
export function distanceTicks(min: number, max: number, target = 7): number[] {
  const span = max - min;
  if (!(span > 0)) return [];
  const raw = span / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * pow >= raw) ?? 10) * pow;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v));
  return out;
}
