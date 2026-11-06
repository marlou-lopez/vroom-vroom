import type { Scene } from "../detailed/scene";
import type { Viewport } from "../../../lib/camera";
import type { AttitudeAt } from "../../../lib/carAttitude";
import type { CarPose } from "./pose";
import type { ViewMode } from "./viewModes";

/** What the 3D renderer draws besides the 2D scene: the road height per centreline grid index. */
export interface RibbonScene { scene: Scene; heights: Float64Array }

export interface RibbonFrame {
  lap: CarPose; ref: CarPose;
  /** Fractional grid distance of each car; the part of each line behind it is drawn bright. */
  lapDist: number; refDist: number;
  /** The point on the lap line a little ahead of the lap car (the chase camera looks at it). */
  ahead: { east: number; north: number; height: number };
  /** The lap car's estimated attitude at lapDist (cockpit camera). */
  lapAtt: AttitudeAt;
  /** True after a seek: camera smoothing restarts. */
  jumped: boolean;
  /** Vertical exaggeration applied to the heights. */
  exaggeration: number;
}

export interface RibbonEvents { onContextLost(): void; onContextRestored(): void; onNeedsDraw(): void }

export interface ScreenPoint { x: number; y: number; visible: boolean }

export interface RibbonRenderer {
  setScene(s: RibbonScene): void;
  setMode(mode: ViewMode): void;
  /** Cheap and idempotent: call on every ResizeObserver tick. */
  resize(v: Viewport, dpr: number): void;
  draw(f: RibbonFrame): void;
  /** Wheel: factor > 1 = further away. Ignored in orbit mode, where the controls handle the wheel. */
  zoom(factor: number): void;
  /** Debug and benchmark: turns the orbit camera around the car by `rad` about the vertical. */
  nudgeOrbit(rad: number): void;
  /** Screen position (CSS px) of a scene point at the last drawn camera; visible is false behind the camera. */
  project(east: number, north: number, height: number, out: ScreenPoint): ScreenPoint;
  /** Draw calls and triangles of the last draw (debug HUD). */
  stats(): { calls: number; triangles: number };
  destroy(): void;
  /** Debug: loses the GPU context, then restores it after 1 s. False when the extension is missing. */
  simulateContextLoss(): boolean;
}

/** Loads three.js and the 3D renderer on demand, as its own chunk. */
export async function loadRibbonRenderer(host: HTMLElement, events: RibbonEvents): Promise<RibbonRenderer> {
  const { createThreeRibbon } = await import("./threeRibbon");
  return createThreeRibbon(host, events);
}
