import { LED_COUNT, ledColour, shiftLights, type RpmLimits } from "../../../lib/shiftLights";
import { colors } from "../../../theme";
import type { DashValues } from "./dashValues";
import {
  BINNACLE, BINNACLE_RADIUS, DASH_REGION, DISPLAY, LEFT_POD, SECOND_DISPLAY, SECOND_SHROUD, WHEEL_HALF, WHEEL_HUB_HALF, WHEEL_MARKER_HALF,
  WHEEL_MARKER_SPAN, WHEEL_PLANE, WHEEL_RIM_INNER, WHEEL_SPOKE_HALF, WHEEL_SPOKE_REACH, pxBox, rectEdges, wheelOutline, type TanRect,
} from "./cockpitLayout";

/**
 * Canvas painters for the cockpit's own-design parts (#101): the dash-top shapes, the steering wheel, the mirror housing, the two
 * displays. Everything is drawn here from theme colours with gradients and soft highlights, nothing is taken from the game. They only
 * use the small `Ctx2D` surface, so tests can pass a recorder.
 */

export type Ctx2D = Pick<
  CanvasRenderingContext2D,
  "clearRect" | "fillRect" | "beginPath" | "arc" | "fill" | "fillText" | "roundRect" | "stroke" | "save" | "restore" | "clip" | "moveTo" | "lineTo" |
  "createLinearGradient" | "createRadialGradient" | "translate" | "rotate"
> & { fillStyle: unknown; strokeStyle: unknown; lineWidth: number; font: string; textAlign: unknown; textBaseline: unknown};

/** The colours the cockpit uses, all from theme tokens. */
export interface CockpitPalette {
  /** Carbon trim: dark base and the lit side. */
  interior: string; trim: string;
  bonnet: string;
  /** The displays' glass and the unlit LED. */
  glass: string; off: string;
  text: string; muted: string;
  green: string; yellow: string; red: string; orange: string; blue: string;
  sky: string; horizon: string; grass: string;
}

/** The dark theme's values (the fallback when a CSS variable is missing). */
export const DEFAULT_PALETTE: CockpitPalette = {
  interior: colors.cockpitInterior, trim: colors.cockpitTrim, bonnet: colors.cockpitBonnet, glass: colors.bg, off: colors.line,
  text: colors.text, muted: colors.muted, green: colors.throttle, yellow: colors.minor, red: colors.brake, orange: colors.issue, blue: colors.you,
  sky: colors.sky, horizon: colors.skyHorizon, grass: colors.grass,
};

/** Reads the palette from the theme's CSS variables on `el`. */
export function readCockpitPalette(el: Element): CockpitPalette {
  const cs = getComputedStyle(el);
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const d = DEFAULT_PALETTE;
  return {
    interior: get("--color-cockpit-interior", d.interior), trim: get("--color-cockpit-trim", d.trim), bonnet: get("--color-cockpit-bonnet", d.bonnet),
    glass: get("--color-bg", d.glass), off: get("--color-line", d.off), text: get("--color-text", d.text), muted: get("--color-muted", d.muted),
    green: get("--color-throttle", d.green), yellow: get("--color-minor", d.yellow), red: get("--color-brake", d.red),
    orange: get("--color-issue", d.orange), blue: get("--color-you", d.blue),
    sky: get("--color-sky", d.sky), horizon: get("--color-sky-horizon", d.horizon), grass: get("--color-grass", d.grass),
  };
}

function rgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [128, 128, 128];
}
/** `hex` mixed towards `to` by `t` (0..1), as "#rrggbb". */
export function mixHex(hex: string, to: string, t: number): string {
  const a = rgb(hex), b = rgb(to);
  return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** The size of the carbon weave tile (px): 2 x 2 tows. */
export const WEAVE_TILE_PX = 16;

/** Paints one 2 x 2 plain-weave tile at low contrast: neighbouring tows run at right angles, each shaded across its width. */
export function paintWeaveTile(ctx: Ctx2D, size = WEAVE_TILE_PX): void {
  const c = size / 2;
  for (let i = 0; i < 4; i++) {
    const cx = (i % 2) * c, cy = Math.floor(i / 2) * c;
    const horizontal = (i % 2) === Math.floor(i / 2);
    const g = horizontal ? ctx.createLinearGradient(cx, cy, cx, cy + c) : ctx.createLinearGradient(cx, cy, cx + c, cy);
    g.addColorStop(0, "rgba(255,255,255,0.07)");
    g.addColorStop(0.5, "rgba(255,255,255,0)");
    g.addColorStop(1, "rgba(0,0,0,0.22)");
    ctx.fillStyle = g;
    ctx.fillRect(cx, cy, c, c);
  }
}

/** A dark body with a lit top edge, a darker bottom and the weave over it; `radii` are the corner radii (px). Leaves the path as the shape. */
function body(ctx: Ctx2D, x: number, y: number, w: number, h: number, radii: number | number[], pal: CockpitPalette, weave: unknown, lift = 0.55): void {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, mixHex(pal.interior, pal.trim, lift));
  g.addColorStop(0.3, mixHex(pal.interior, pal.trim, lift * 0.35));
  g.addColorStop(1, mixHex(pal.interior, "#000000", 0.35));
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radii);
  ctx.fillStyle = g;
  ctx.fill();
  if (weave) {
    ctx.fillStyle = weave;
    ctx.fill();
  }
  // Rim light along the top edge and a dark outline.
  ctx.lineWidth = Math.max(1.5, h * 0.012);
  const rim = ctx.createLinearGradient(0, y, 0, y + h * 0.5);
  rim.addColorStop(0, rgba(pal.trim, 0.9));
  rim.addColorStop(1, rgba(pal.trim, 0));
  ctx.strokeStyle = rim;
  ctx.stroke();
}

/** A recessed dark screen bay with a soft inner shadow, at the pixel box (`x`, `y`, `w`, `h`). */
function recess(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number, pal: CockpitPalette): void {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, "#000000");
  g.addColorStop(1, mixHex(pal.glass, "#000000", 0.5));
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = Math.max(2, h * 0.03);
  ctx.strokeStyle = rgba(pal.trim, 0.35);
  ctx.stroke();
}

/** Slots along an edge: a row of short light marks (the dash's vents and the display's bezel marks). */
function marks(ctx: Ctx2D, x0: number, x1: number, y: number, n: number, len: number, thick: number, pal: CockpitPalette): void {
  ctx.fillStyle = rgba(pal.trim, 0.7);
  for (let i = 0; i < n; i++) {
    const x = x0 + ((x1 - x0) * i) / Math.max(n - 1, 1);
    ctx.fillRect(x - len / 2, y, len, thick);
  }
}

/** Paints the dash-top texture: the binnacle, the switch pod to its left and the second display's shroud (`w` x `h` covers `DASH_REGION`). */
export function paintDashTop(ctx: Ctx2D, w: number, h: number, pal: CockpitPalette, weave: unknown): void {
  ctx.clearRect(0, 0, w, h);
  const R = DASH_REGION;
  const box = (r: TanRect) => pxBox(r, R, w, h);
  const px = (v: number) => v * (w / (R.x1 - R.x0));
  const b = box(BINNACLE);
  body(ctx, b.x, b.y, b.w, b.h, [px(BINNACLE_RADIUS), px(BINNACLE_RADIUS), 0, 0], pal, weave);
  marks(ctx, b.x + b.w * 0.18, b.x + b.w * 0.82, b.y + b.h * 0.05, 9, px(0.02), 4, pal);
  const p = box(LEFT_POD);
  body(ctx, p.x, p.y, p.w, p.h, px(0.02), pal, weave, 0.4);
  recess(ctx, p.x + p.w * 0.12, p.y + p.h * 0.2, p.w * 0.76, p.h * 0.62, px(0.008), pal);
  const s = box(SECOND_SHROUD);
  body(ctx, s.x, s.y, s.w, s.h, [px(0.04), px(0.04), px(0.02), px(0.02)], pal, weave);
  marks(ctx, s.x + s.w * 0.15, s.x + s.w * 0.85, s.y + s.h * 0.05, 7, px(0.02), 4, pal);
  paintBays(ctx, w, h, [DISPLAY, SECOND_DISPLAY], pal);
}

/** The dash-top texture needs the screens' bays too; they are cut by the displays drawn over them, so only the bezels need painting. */
function paintBays(ctx: Ctx2D, w: number, h: number, bays: readonly TanRect[], pal: CockpitPalette): void {
  const R = DASH_REGION;
  for (const r of bays) {
    const e = rectEdges({ ...r, w: r.w + 0.026, h: r.h + 0.026 });
    const m = pxBox({ cx: (e.x0 + e.x1) / 2, cy: (e.y0 + e.y1) / 2, w: e.x1 - e.x0, h: e.y1 - e.y0 }, R, w, h);
    recess(ctx, m.x, m.y, m.w, m.h, m.h * 0.06, pal);
  }
}

/** The mirror's housing: a dark, glossy frame with a bay for the glass (`glass` is the glass's box relative to the housing, 0..1). */
export function paintMirrorHousing(ctx: Ctx2D, w: number, h: number, glass: { x: number; y: number; w: number; h: number }, pal: CockpitPalette, weave: unknown): void {
  ctx.clearRect(0, 0, w, h);
  body(ctx, 0, 0, w, h, [h * 0.18, h * 0.18, h * 0.3, h * 0.3], pal, weave, 0.7);
  recess(ctx, glass.x * w, glass.y * h, glass.w * w, glass.h * h, h * 0.06, pal);
}

/** The mirror's picture when the live one is off: sky into haze above a dark verge, softly vignetted. */
export function paintMirrorFallback(ctx: Ctx2D, w: number, h: number, pal: CockpitPalette): void {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, pal.sky);
  g.addColorStop(0.48, pal.horizon);
  g.addColorStop(0.5, mixHex(pal.grass, "#000000", 0.2));
  g.addColorStop(1, mixHex(pal.grass, "#000000", 0.55));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const v = ctx.createLinearGradient(0, 0, w, 0);
  v.addColorStop(0, "rgba(0,0,0,0.35)");
  v.addColorStop(0.2, "rgba(0,0,0,0)");
  v.addColorStop(0.8, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
}

/**
 * Paints the wheel on `WHEEL_PX`, the hub at the centre: a rounded-rectangle rim (a ring), a cross spoke, a lower spoke, a square hub
 * and an orange 12 o'clock marker across the rim's top, so the rotation reads. Colours come from the palette.
 */
export function paintWheel(ctx: Ctx2D, w: number, h: number, pal: CockpitPalette): void {
  ctx.clearRect(0, 0, w, h);
  const sx = w / WHEEL_PLANE[0]; // px per tan unit
  const X = (tx: number) => w / 2 + tx * sx, Y = (ty: number) => h / 2 - ty * sx;
  const [a, b] = WHEEL_HALF;
  const ring = (k: number, reverse: boolean) => {
    const pts = wheelOutline(a * k, b * k);
    if (reverse) pts.reverse();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(X(x), Y(y)) : ctx.lineTo(X(x), Y(y))));
  };
  // Rim: outer outline and the inner one the other way round, so the fill leaves the hole open.
  const g = ctx.createLinearGradient(0, Y(b), 0, Y(-b));
  g.addColorStop(0, mixHex(pal.interior, pal.trim, 0.45));
  g.addColorStop(0.5, mixHex(pal.interior, pal.trim, 0.2));
  g.addColorStop(1, mixHex(pal.interior, "#000000", 0.2));
  ctx.beginPath();
  ring(1, false);
  ring(WHEEL_RIM_INNER, true);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = rgba(pal.trim, 0.6);
  ctx.lineWidth = Math.max(2, 0.004 * sx);
  ctx.beginPath();
  ring(1, false);
  ctx.stroke();
  // Spokes and hub.
  const spoke = mixHex(pal.interior, "#000000", 0.2);
  const bar = (x0: number, y0: number, x1: number, y1: number, colour: string) => {
    ctx.fillStyle = colour;
    ctx.fillRect(X(x0), Y(y1), (x1 - x0) * sx, (y1 - y0) * sx);
  };
  bar(-a * WHEEL_SPOKE_REACH, -WHEEL_SPOKE_HALF, a * WHEEL_SPOKE_REACH, WHEEL_SPOKE_HALF, spoke);
  bar(-WHEEL_SPOKE_HALF, -b * WHEEL_SPOKE_REACH, WHEEL_SPOKE_HALF, 0, spoke);
  bar(-WHEEL_HUB_HALF, -WHEEL_HUB_HALF, WHEEL_HUB_HALF, WHEEL_HUB_HALF, mixHex(pal.interior, pal.trim, 0.5));
  // 12 o'clock marker.
  bar(-WHEEL_MARKER_HALF, b * WHEEL_MARKER_SPAN[0], WHEEL_MARKER_HALF, b * WHEEL_MARKER_SPAN[1], pal.orange);
}

/** The colour of each shift light on the display: the light's colour when lit, else the unlit one. */
export function ledStates(v: DashValues, limits: RpmLimits | null, pal: CockpitPalette): string[] {
  const l = shiftLights(v.rpm, limits, v.clockS);
  const lit = { green: pal.green, yellow: pal.yellow, red: pal.red };
  return Array.from({ length: LED_COUNT }, (_, i) => (i < l.lit && l.flashOn ? lit[ledColour(i)] : pal.off));
}

export const gearLabel = (g: number): string => (g < 0 ? "R" : g === 0 ? "N" : String(g));

/** The values the central display shows, rounded as it shows them: it is redrawn only when this changes. */
export function dashKey(v: DashValues, limits: RpmLimits | null): string {
  const l = shiftLights(v.rpm, limits, v.clockS);
  return [v.gear, Math.round(v.speedKmh), Math.round(v.rpm / 100), l.lit, l.flashing && !l.flashOn ? 0 : 1, Math.round(v.throttle * 20), Math.round(v.brake * 20)].join("|");
}

const FONT = "Inter, system-ui, sans-serif";

/** A rounded glass panel with a soft top sheen. */
function glass(ctx: Ctx2D, w: number, h: number, pal: CockpitPalette): void {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, mixHex(pal.glass, pal.trim, 0.22));
  g.addColorStop(0.5, pal.glass);
  g.addColorStop(1, mixHex(pal.glass, "#000000", 0.4));
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, h * 0.06);
  ctx.fillStyle = g;
  ctx.fill();
}

/** A horizontal bar: dark track, gradient fill of `share` (0..1) of the length from x. */
function bar(ctx: Ctx2D, x: number, y: number, len: number, thick: number, share: number, colour: string, pal: CockpitPalette): void {
  ctx.beginPath();
  ctx.roundRect(x, y, len, thick, thick / 2);
  ctx.fillStyle = mixHex(pal.glass, pal.trim, 0.3);
  ctx.fill();
  const fill = len * Math.min(Math.max(share, 0), 1);
  if (fill < thick) return;
  const g = ctx.createLinearGradient(x, 0, x + fill, 0);
  g.addColorStop(0, mixHex(colour, "#000000", 0.35));
  g.addColorStop(1, colour);
  ctx.beginPath();
  ctx.roundRect(x, y, fill, thick, thick / 2);
  ctx.fillStyle = g;
  ctx.fill();
}

/** Paints the central display: shift lights, gear (large), rpm and speed, throttle and brake bars. */
export function paintDash(ctx: Ctx2D, w: number, h: number, v: DashValues, limits: RpmLimits | null, pal: CockpitPalette): void {
  ctx.clearRect(0, 0, w, h);
  glass(ctx, w, h, pal);
  // Shift lights, with a halo round each lit one.
  const leds = ledStates(v, limits, pal), x0 = 56, x1 = w - 56, y = 32;
  leds.forEach((c, i) => {
    const x = x0 + ((x1 - x0) * i) / (LED_COUNT - 1);
    if (c !== pal.off) {
      const halo = ctx.createRadialGradient(x, y, 4, x, y, 24);
      halo.addColorStop(0, rgba(c, 0.55));
      halo.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, y, 24, 0, 2 * Math.PI);
      ctx.fill();
    }
    const g = ctx.createRadialGradient(x - 3, y - 3, 1, x, y, 12);
    g.addColorStop(0, mixHex(c, "#ffffff", c === pal.off ? 0.08 : 0.5));
    g.addColorStop(1, c);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, 2 * Math.PI);
    ctx.fill();
  });
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  // Gear, large; at the limit it takes the red light's colour.
  const l = shiftLights(v.rpm, limits, v.clockS);
  ctx.fillStyle = l.flashing && l.flashOn ? pal.red : pal.text;
  ctx.font = `700 136px ${FONT}`;
  ctx.fillText(gearLabel(v.gear), w / 2, 128);
  // Rpm (left) and speed (right).
  ctx.fillStyle = pal.text;
  ctx.font = `700 50px ${FONT}`;
  ctx.fillText(String(Math.round(v.rpm / 10) * 10), 100, 118);
  ctx.fillText(String(Math.round(v.speedKmh)), w - 100, 118);
  ctx.fillStyle = pal.muted;
  ctx.font = `600 18px ${FONT}`;
  ctx.fillText("RPM", 100, 158);
  ctx.fillText("KPH", w - 100, 158);
  // Throttle (green) and brake (red) bars along the bottom.
  const bw = (w - 3 * 28) / 2;
  bar(ctx, 28, h - 44, bw, 14, v.throttle, pal.green, pal);
  bar(ctx, w - 28 - bw, h - 44, bw, 14, v.brake, pal.red, pal);
  ctx.fillStyle = pal.muted;
  ctx.font = `600 14px ${FONT}`;
  ctx.fillText("THR", 28 + bw / 2, h - 18);
  ctx.fillText("BRK", w - 28 - bw / 2, h - 18);
}

/** "+0.142" (behind the reference), "-0.031" (ahead), or "--" without a delta. */
export function deltaLabel(deltaS: number | null): string {
  if (deltaS == null || !Number.isFinite(deltaS)) return "--";
  const r = Math.round(deltaS * 100) / 100;
  return (r > 0 ? "+" : r < 0 ? "-" : "") + Math.abs(r).toFixed(2);
}

/** What the second display redraws on: the delta to two decimals. */
export const deltaKey = (v: DashValues): string => (v.deltaS == null ? "-" : String(Math.round(v.deltaS * 100)));

/** Full scale of the delta bar (seconds). */
export const DELTA_BAR_FULL_S = 1;

/** Paints the second display: the live delta to the reference lap, large and coloured (red behind, green ahead), with a bar around its centre. */
export function paintDelta(ctx: Ctx2D, w: number, h: number, v: DashValues, pal: CockpitPalette): void {
  ctx.clearRect(0, 0, w, h);
  glass(ctx, w, h, pal);
  const d = v.deltaS;
  const colour = d == null ? pal.muted : d > 0.005 ? pal.red : d < -0.005 ? pal.green : pal.text;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillStyle = pal.muted;
  ctx.font = `600 20px ${FONT}`;
  ctx.fillText("DELTA TO REFERENCE", w / 2, 36);
  ctx.fillStyle = colour;
  ctx.font = `700 92px ${FONT}`;
  ctx.fillText(deltaLabel(d), w / 2, 118);
  // Bar: the middle is zero; red grows to the right when behind, green to the left when ahead.
  const bx = 40, bw = w - 80, by = 188, bh = 16, mid = bx + bw / 2;
  bar(ctx, bx, by, bw, bh, 0, colour, pal);
  if (d != null) {
    const share = Math.min(Math.abs(d) / DELTA_BAR_FULL_S, 1) * (bw / 2);
    if (share >= bh / 2) {
      const x = d > 0 ? mid : mid - share;
      const g = ctx.createLinearGradient(x, 0, x + share, 0);
      g.addColorStop(0, d > 0 ? mixHex(colour, "#000000", 0.35) : colour);
      g.addColorStop(1, d > 0 ? colour : mixHex(colour, "#000000", 0.35));
      ctx.beginPath();
      ctx.roundRect(x, by, share, bh, bh / 2);
      ctx.fillStyle = g;
      ctx.fill();
    }
  }
  ctx.fillStyle = rgba(pal.text, 0.8);
  ctx.fillRect(mid - 1.5, by - 6, 3, bh + 12);
  ctx.fillStyle = pal.muted;
  ctx.font = `600 18px ${FONT}`;
  ctx.fillText(d == null ? "NO REFERENCE" : d > 0.005 ? "BEHIND" : d < -0.005 ? "AHEAD" : "LEVEL", w / 2, h - 30);
}
