// Gear strip and shift markers (vroom-pnw.12). The grid has one gear value per metre; a shift is where it changes.

/** A gear change at grid index `i` (metre): `from` → `to`. */
export interface Shift { i: number; from: number; to: number }

/**
 * The gear channel with single-sample blips removed: a sample that differs from both neighbours, and whose neighbours
 * agree, takes their value (LMU's Gear event passes through 0 for a moment during a shift; the extractor drops most).
 */
export function cleanGear(gear: ArrayLike<number>): number[] {
  const out = Array.from(gear);
  for (let i = 1; i < out.length - 1; i++) {
    if (out[i] !== out[i - 1] && out[i - 1] === gear[i + 1]) out[i] = out[i - 1];
  }
  return out;
}

/** Every gear change in the lap, in order. Single-sample blips are not shifts. */
export function gearShifts(gear: ArrayLike<number>): Shift[] {
  const g = cleanGear(gear);
  const shifts: Shift[] = [];
  for (let i = 1; i < g.length; i++) {
    if (g[i] !== g[i - 1]) shifts.push({ i, from: g[i - 1], to: g[i] });
  }
  return shifts;
}

/** Label for a gear: R, N or the number. */
export function gearName(g: number): string {
  return g < 0 ? "R" : g === 0 ? "N" : String(g);
}

/** Marker label, e.g. `3→4`. */
export function shiftLabel(s: Shift): string {
  return `${gearName(s.from)}→${gearName(s.to)}`;
}
