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
