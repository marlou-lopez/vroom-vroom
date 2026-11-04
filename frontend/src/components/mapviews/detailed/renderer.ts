import type { Camera, Viewport } from "../../../lib/camera";
import type { Pt } from "../../../lib/geo";
import type { Scene } from "./scene";

export interface Frame { camera: Camera; viewport: Viewport; lapCar: Pt; refCar: Pt; lapHeading: number; refHeading: number;
  /** Fractional grid distance (metres) of each car on its own line; the lines are drawn in full colour only up to here. */
  lapDist: number; refDist: number }

export interface Renderer {
  setScene(s: Scene): void;
  /** Cheap and idempotent: call on every ResizeObserver tick. */
  resize(v: Viewport, dpr: number): void;
  draw(f: Frame): void;
  /** Removes everything this renderer added to the host. Safe on a lost context. */
  destroy(): void;
  /** Debug: loses the GPU context, then restores it after 1 s. False when the extension is missing. */
  simulateContextLoss(): boolean;
  /** Show or hide the thin, dimmed part of each line the car has not reached yet (#48). */
  setAheadVisible(visible: boolean): void;
}

export interface RendererEvents { onContextLost(): void; onContextRestored(): void }

export interface Colors { you: string; comparison: string; line: string; bg: string; text: string }

/** Drawing constants shared by all renderers (CSS px, constant at every zoom). */
export const EDGE_PX = 1;
export const REF_PX = 2;
export const LAP_PX = 2.5;
export const CAR_R_PX = 4;
export const CASING_PX = 4;
/** Lines are drawn this far from their colour toward the background, so the full-colour cars stand out on them. */
export const LINE_DIM = 0.45;
/** The part of a line the car has not driven yet is dimmed this far toward the background (instead of LINE_DIM) and drawn at half width. */
export const AHEAD_DIM = 0.75;
/** Below this view width (metres) the cars are drawn as chevrons. */
export const CHEVRON_BELOW_M = 300;
export const CHEVRON_LEN_PX = 12;
export const CHEVRON_WID_PX = 9;

export function readColors(el: Element): Colors {
  const cs = getComputedStyle(el);
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    you: get("--color-you", "#3DD6F5"),
    comparison: get("--color-comparison", "#B9C0CA"),
    line: get("--color-line", "#23272E"),
    bg: get("--color-bg", "#0E0F11"),
    text: get("--color-text", "#D8DCE2"),
  };
}

export async function loadRenderer(host: HTMLElement, events: RendererEvents): Promise<Renderer> {
  const { createWebglRenderer } = await import("./webglRenderer");
  return createWebglRenderer(host, events);
}
