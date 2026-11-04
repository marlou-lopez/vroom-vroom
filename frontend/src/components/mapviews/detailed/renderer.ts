import type { Camera, Viewport } from "../../../lib/camera";
import type { Pt } from "../../../lib/geo";
import type { Scene } from "./scene";
import { createCanvasRenderer } from "./canvasRenderer";
import { createSvgRenderer } from "./svgRenderer";

export type RendererKind = "svg" | "canvas" | "webgl";

export interface Frame { camera: Camera; viewport: Viewport; lapCar: Pt; refCar: Pt; lapHeading: number; refHeading: number }

export interface Renderer {
  setScene(s: Scene): void;
  /** Cheap and idempotent: call on every ResizeObserver tick. */
  resize(v: Viewport, dpr: number): void;
  draw(f: Frame): void;
  /** Removes everything this renderer added to the host. */
  destroy(): void;
}

export interface Colors { you: string; comparison: string; line: string; bg: string; text: string }

/** Drawing constants shared by all renderers (CSS px, constant at every zoom). */
export const EDGE_PX = 1;
export const REF_PX = 2;
export const LAP_PX = 2.5;
export const CAR_R_PX = 4;
export const CASING_PX = 4;
/** Lines are drawn this far from their colour toward the background, so the full-colour cars stand out on them. */
export const LINE_DIM = 0.45;
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

/** World to screen as an affine matrix [a b c d e f] (CSS px), equivalent to `worldToScreen`. */
export function cameraMatrix(c: Camera, v: Viewport): [number, number, number, number, number, number] {
  const s = v.w / c.widthM;
  const cos = Math.cos(c.rotation), sin = Math.sin(c.rotation);
  const a = s * cos, b = -s * sin, cc = -s * sin, d = -s * cos;
  return [a, b, cc, d, v.w / 2 - (a * c.cx + cc * c.cy), v.h / 2 - (b * c.cx + d * c.cy)];
}

export async function createRenderer(kind: RendererKind, host: HTMLElement): Promise<Renderer> {
  if (kind === "svg") return createSvgRenderer(host);
  if (kind === "canvas") return createCanvasRenderer(host);
  const { createWebglRenderer } = await import("./webglRenderer");
  return createWebglRenderer(host);
}
