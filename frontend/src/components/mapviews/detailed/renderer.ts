import type { CarDims } from "../../../api/types";
import { zoomScale, type Camera, type Viewport } from "../../../lib/camera";
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
  /** Gain/loss colours (#59): off, a line beside the track, or the track surface. Both are one tone the whole lap (no split at the car). */
  setGainStyle(style: GainStyle): void;
  /** Debug: tint the edge stretches telemetry measured (#36). Off, every edge is the plain line colour. Recolours in place. */
  setEdgeDebug(on: boolean): void;
}

/** "side": a line left of the track; "track": the whole track width between the edges (experimental, to compare). */
export type GainStyle = "off" | "side" | "track";
export const GAIN_STYLES: readonly GainStyle[] = ["off", "side", "track"];

export interface RendererEvents { onContextLost(): void; onContextRestored(): void }

export interface Colors { you: string; comparison: string; line: string; bg: string; text: string; gain: string; loss: string }

/** Drawing constants shared by all renderers (CSS px, constant at every zoom). */
export const EDGE_PX = 1;
export const REF_PX = 2;
export const LAP_PX = 2.5;
export const CAR_R_PX = 4;
export const CASING_PX = 4;
/** Reference line dash and gap length along the line (CSS px at 1x zoom; both scale with the line width, like zoomScale). */
export const REF_DASH_PX = 8;
export const REF_GAP_PX = 5;
/** Lines are drawn this far from their colour toward the background, so the full-colour cars stand out on them. */
export const LINE_DIM = 0.45;
/** The part of a line the car has not driven yet is dimmed this far toward the background (instead of LINE_DIM) and drawn at half width. */
export const AHEAD_DIM = 0.75;
/** Below this view width (metres) the cars are drawn as chevrons. */
export const CHEVRON_BELOW_M = 300;
export const CHEVRON_LEN_PX = 12;
export const CHEVRON_WID_PX = 9;
/** Generic GT3 size, used when the contract has no dimensions for a car (`car_dims` null). */
export const FALLBACK_CAR_DIMS: CarDims = { length_m: 4.7, width_m: 2.0 };

/** The dims to draw with: the contract's, or the generic GT3 size when unknown. */
/** How far the car's visual centre is ahead of the recorded position (m); 0 when the car has no known offset. */
export const visualForwardM = (d: CarDims): number => d.visual_offset?.forward_m ?? 0;

export const carDimsOrFallback = (d: CarDims | null | undefined): CarDims => d ?? FALLBACK_CAR_DIMS;

/**
 * True when a car is drawn as its true-size footprint instead of the dot/chevron marker: when the real car is at least as long
 * on screen as the chevron would be (at this zoom's scale). Zoomed out the footprint would shrink to a sub-pixel speck, so the
 * marker stays; zoomed in the marker would be far smaller than the car.
 */
export function showFootprint(dims: CarDims, widthM: number, viewportW: number): boolean {
  const pxPerMetre = viewportW / widthM;
  return dims.length_m * pxPerMetre >= CHEVRON_LEN_PX * zoomScale(widthM);
}
/** Gain/loss line width, and its gap (CSS px) outside the widest line it runs beside (the ref line's casing). */
export const GAIN_PX = 3;
export const GAIN_GAP_PX = 3;
/** The track-surface colours are dimmed this far toward the background, so the racing lines on top stay readable. One tone for the whole lap: no driven/ahead split. */
export const SURFACE_DIM = 0.55;

/**
 * Metres to add outside the clearance so the gain/loss line keeps a fixed screen gap at every zoom: half the casing,
 * the gap, half its own width (widths scale with zoomScale `z`, the gap does not), converted at `widthM / viewportW`.
 */
export function gainExtraM(widthM: number, viewportW: number, z: number): number {
  return ((CASING_PX * z) / 2 + GAIN_GAP_PX + (GAIN_PX * z) / 2) * (widthM / Math.max(viewportW, 1));
}

/**
 * Dash and gap length in metres along the line, so dashes keep the same size on screen at every zoom.
 * LineMaterial takes them in world units; `z` is zoomScale, so the pattern follows the line width.
 */
export function dashWorld(widthM: number, viewportW: number, z: number): { dash: number; gap: number } {
  const unit = widthM / Math.max(viewportW, 1); // metres per px
  return { dash: REF_DASH_PX * z * unit, gap: REF_GAP_PX * z * unit };
}

export function readColors(el: Element): Colors {
  const cs = getComputedStyle(el);
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    you: get("--color-you", "#3DD6F5"),
    comparison: get("--color-comparison", "#B9C0CA"),
    line: get("--color-line", "#23272E"),
    bg: get("--color-bg", "#0E0F11"),
    text: get("--color-text", "#D8DCE2"),
    gain: get("--color-strength", "#34B88A"),
    loss: get("--color-issue", "#FF7A59"),
  };
}

export async function loadRenderer(host: HTMLElement, events: RendererEvents): Promise<Renderer> {
  const { createWebglRenderer } = await import("./webglRenderer");
  return createWebglRenderer(host, events);
}

/** Debug view only: measured edge stretches are mixed this far from the line colour toward the text colour, as an sRGB (screen) mix (#36). */
export const EDGE_MEASURED_LIFT = 0.25;

/** Mixes two "#rrggbb" colours by t in sRGB space. three.js lerps in linear space, which looks far stronger on screen. */
export function mixSrgb(a: string, b: string, t: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
  let out = "#";
  for (let i = 0; i < 3; i++) out += Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, "0");
  return out;
}
/** Kerb line width in metres (world units, so it scales with the zoom like a real object), and the length of each red or white stripe in grid metres. */
export const KERB_W_M = 0.9;
export const KERB_STRIPE_M = 2;
/** Physical kerb colours, not theme tokens. */
export const KERB_RED = "#C8463C";
export const KERB_WHITE = "#D8DCE2";
