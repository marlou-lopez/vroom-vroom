import type { Viewport } from "../../../lib/camera";
import { formatDelta, formatLapTime, gearLabel } from "../../../lib/format";
import type { AttitudeAt } from "../../../lib/carAttitude";
import type { RpmLimits } from "../../../lib/shiftLights";
import type { DashValues } from "./dashValues";

/** What the split view's second pane (the reference lap) needs beyond the pose the frame already carries. */
export interface RefPaneFrame {
  /** The reference car's estimated attitude (cockpit camera). */
  att: AttitudeAt;
  /** The reference car's dash values and rev limits (cockpit wheel and dash). */
  dash: DashValues;
  limits: RpmLimits | null;
  /** The point on the reference line a little ahead of the reference car (the chase camera looks at it). */
  ahead: { east: number; north: number; height: number };
  /** True when the reference car jumped (a seek, or switching between time and distance sync): its camera smoothing restarts. */
  jumped: boolean;
}

export interface PaneRect { x: number; y: number; w: number; h: number }

/** The pane rectangles in CSS px with the origin at the top left: one full pane, or two halves (lap left, reference right). */
export function paneRects(v: Viewport, split: boolean): PaneRect[] {
  if (!split) return [{ x: 0, y: 0, w: v.w, h: v.h }];
  const left = Math.floor(v.w / 2);
  return [{ x: 0, y: 0, w: left, h: v.h }, { x: left, y: 0, w: v.w - left, h: v.h }];
}

/** `2:23.751 · 214 km/h · 5`: the pane label's live part. */
export function paneReadout(speedKmh: number, gear: number): string {
  return `${Math.round(speedKmh)} km/h · ${gearLabel(gear)}`;
}

export function paneTitle(who: "Lap" | "Reference", lapTimeS: number | null): string {
  return `${who} ${formatLapTime(lapTimeS)}`;
}

/** The live delta label: + means the lap is behind the reference at this point of the track. */
export function deltaLabel(deltaS: number): string {
  return `${formatDelta(Math.abs(deltaS) < 0.0005 ? 0 : deltaS)} s`;
}
