import type { Bounds, Pt } from "./geo";

/** Centre in world metres, widthM = metres across the viewport width, rotation = radians the world is turned counter-clockwise on screen. */
export interface Camera { cx: number; cy: number; widthM: number; rotation: number }
/** Viewport size in CSS px. */
export interface Viewport { w: number; h: number }

/** Smallest zoom: metres across the viewport. */
export const MIN_WIDTH_M = 20;
/** Default metres across the viewport while following the car. */
export const FOLLOW_WIDTH_M = 150;

/** World metres (y north) to screen px (y down); scale is v.w / widthM px per metre. */
export function worldToScreen(c: Camera, v: Viewport, p: Pt): Pt {
  const s = v.w / c.widthM;
  const dx = p.x - c.cx, dy = p.y - c.cy;
  const cos = Math.cos(c.rotation), sin = Math.sin(c.rotation);
  return { x: v.w / 2 + (dx * cos - dy * sin) * s, y: v.h / 2 - (dx * sin + dy * cos) * s };
}

/** Exact inverse of worldToScreen. */
export function screenToWorld(c: Camera, v: Viewport, p: Pt): Pt {
  const s = v.w / c.widthM;
  const rx = (p.x - v.w / 2) / s, ry = (v.h / 2 - p.y) / s;
  const cos = Math.cos(c.rotation), sin = Math.sin(c.rotation);
  return { x: c.cx + rx * cos + ry * sin, y: c.cy - rx * sin + ry * cos };
}

/** North-up camera centred on the bounds that fits them inside the viewport minus padPx (CSS px) on every side. */
export function fitBounds(b: Bounds, v: Viewport, padPx = 16): Camera {
  const spanX = Math.max(b.maxX - b.minX, 1), spanY = Math.max(b.maxY - b.minY, 1);
  const availW = Math.max(v.w - 2 * padPx, 1), availH = Math.max(v.h - 2 * padPx, 1);
  const w = Math.max(v.w, 1);
  return {
    cx: (b.minX + b.maxX) / 2,
    cy: (b.minY + b.maxY) / 2,
    widthM: Math.max(spanX * w / availW, spanY * w / availH),
    rotation: 0,
  };
}

/** Zoom by factor (> 1 zooms out), clamped to limits (metres), keeping the world point under `screen` fixed. */
export function zoomAt(c: Camera, v: Viewport, screen: Pt, factor: number, limits: { minM: number; maxM: number }): Camera {
  const widthM = Math.min(Math.max(c.widthM * factor, limits.minM), limits.maxM);
  const before = screenToWorld(c, v, screen);
  const next = { ...c, widthM };
  const after = screenToWorld(next, v, screen);
  return { ...next, cx: c.cx + before.x - after.x, cy: c.cy + before.y - after.y };
}

/** Drag by (dxPx, dyPx) screen px: the content follows the pointer, whatever the rotation. */
export function panBy(c: Camera, v: Viewport, dxPx: number, dyPx: number): Camera {
  const s = v.w / c.widthM;
  const rx = dxPx / s, ry = -dyPx / s;
  const cos = Math.cos(c.rotation), sin = Math.sin(c.rotation);
  return { ...c, cx: c.cx - (rx * cos + ry * sin), cy: c.cy - (-rx * sin + ry * cos) };
}

/** The same camera turned north-up: rotation 0, same centre and width, so the place and zoom on screen stay put (#60). */
export function northUp(c: Camera): Camera {
  return { ...c, rotation: 0 };
}

/** Camera centred on the car (metres); heading in radians; headingUp rotates so travel points up the screen. */
export function followCamera(car: Pt, heading: number, widthM: number, headingUp: boolean): Camera {
  return { cx: car.x, cy: car.y, widthM, rotation: headingUp ? Math.PI / 2 - heading : 0 };
}

/** Blend heading `prev` toward `next` (radians) along the shortest arc; result in (-pi, pi]. */
export function smoothHeading(prev: number, next: number, alpha: number): number {
  const TAU = 2 * Math.PI;
  let diff = (next - prev) % TAU;
  if (diff > Math.PI) diff -= TAU;
  else if (diff <= -Math.PI) diff += TAU;
  let r = (prev + diff * alpha) % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r <= -Math.PI) r += TAU;
  return r;
}

/** View width (m) at or above which line widths and car markers are drawn at their base size. */
export const ZOOM_SCALE_FROM_M = 300;
/** Size multiplier reached at the closest zoom (MIN_WIDTH_M). */
export const ZOOM_SCALE_MAX = 1.8;

/**
 * Multiplier for line widths and car markers: 1 when the view is ZOOM_SCALE_FROM_M or wider, growing on a log
 * scale to ZOOM_SCALE_MAX at MIN_WIDTH_M, so lines and cars get a bit thicker as you zoom in.
 */
export function zoomScale(widthM: number): number {
  const t = Math.log(ZOOM_SCALE_FROM_M / widthM) / Math.log(ZOOM_SCALE_FROM_M / MIN_WIDTH_M);
  return 1 + (ZOOM_SCALE_MAX - 1) * Math.min(1, Math.max(0, t));
}
