/**
 * Where everything in the cockpit view sits (#101), in the camera's view-angle ("tan") space: (tan of the horizontal angle, tan of
 * the vertical angle) from the view axis, + = right / up, so the layout holds for any window aspect. Measured from the user's own
 * in-game screenshots (1920x1080, vertical FOV 44 deg, so 1336.6 px per tan unit around the centre (960, 540)) and used for
 * placement and proportions only: every shape here is drawn by us (see cockpit-view.md for what is measured and what is invented).
 * Pure data and maths, unit-tested.
 */

export type V2 = readonly [number, number];

/** A rectangle in tan space: centre, size and the corner radius of its drawn shape. */
export interface TanRect { cx: number; cy: number; w: number; h: number }

export const rectEdges = (r: TanRect) => ({ x0: r.cx - r.w / 2, x1: r.cx + r.w / 2, y0: r.cy - r.h / 2, y1: r.cy + r.h / 2 });

/** Half the vertical field of view as a tan (44 deg): the top of the view. */
export const VIEW_TOP = Math.tan((22 * Math.PI) / 180);

/** The rear-view mirror's glass in the roof header, top centre (the game's mirror spans px x 555..1365, y 10..118). */
export const MIRROR: TanRect = { cx: 0, cy: 0.3565, w: 0.606, h: 0.081 };
/** The mirror's housing, a little larger than the glass; its top edge is at the top of the view. */
export const MIRROR_HOUSING: TanRect = { cx: 0, cy: 0.3545, w: 0.646, h: 0.101 };
/** The mirror's render target size: the glass's aspect (7.5) at a small size. */
export const MIRROR_PX: V2 = [768, 103];
export const MIRROR_HOUSING_PX: V2 = [1024, 160];

/** The central display's screen (px x 783..1125, y 722..870). */
export const DISPLAY: TanRect = { cx: -0.0045, cy: -0.1915, w: 0.255, h: 0.111 };
export const DISPLAY_PX: V2 = [560, 244];
/** The second display's screen, to the right (px x 1322..1668, y 730..910). */
export const SECOND_DISPLAY: TanRect = { cx: 0.4005, cy: -0.2095, w: 0.259, h: 0.135 };
export const SECOND_PX: V2 = [518, 270];

/**
 * Where the central display's gear digit and shift-light row fall in tan space, from `paintDash`'s layout on the 560 x 244 canvas (the
 * digit: 136 px bold, about 76 x 98 px, centred at (280, 128); the lights: ten dots of radius 12 at y 32 from x 56 to 504).
 */
const displayPx = (x0: number, y0: number, x1: number, y1: number): TanRect => {
  const k = DISPLAY.w / DISPLAY_PX[0];
  return { cx: DISPLAY.cx + ((x0 + x1) / 2 - DISPLAY_PX[0] / 2) * k, cy: DISPLAY.cy - ((y0 + y1) / 2 - DISPLAY_PX[1] / 2) * k, w: (x1 - x0) * k, h: (y1 - y0) * k };
};
export const GEAR_DIGIT: TanRect = displayPx(242, 79, 318, 177);
export const SHIFT_LIGHT_ROW: TanRect = displayPx(44, 20, 516, 44);

/** The shapes on the dash top, as drawn in one texture: the central binnacle, a switch pod on its left, the shroud of the second display. */
export const BINNACLE: TanRect = { cx: -0.005, cy: -0.275, w: 0.38, h: 0.35 }; // top at -0.100, runs down under the wheel
export const BINNACLE_RADIUS = 0.075;
export const LEFT_POD: TanRect = { cx: -0.304, cy: -0.222, w: 0.2, h: 0.1 };
export const SECOND_SHROUD: TanRect = { cx: 0.405, cy: -0.225, w: 0.35, h: 0.24 }; // top at -0.105
/** The tan region the dash-top texture covers, and its size in px (about 1500 px per tan unit). */
export const DASH_REGION = { x0: -0.44, x1: 0.62, y0: -0.42, y1: -0.09 } as const;
export const DASH_PX: V2 = [1590, 495];

/** The steering wheel's hub centre (px (952, 1073)), the plane it is drawn on (turned about the hub) and its texture size. */
export const WHEEL_CENTRE: V2 = [-0.006, -0.399];
export const WHEEL_PLANE: V2 = [0.66, 0.41];
export const WHEEL_PX: V2 = [1056, 656];
/**
 * The wheel's design, relative to the hub (tan units): a rounded-rectangle rim (a superellipse of order 4, like a GT wheel) of half
 * width 0.26 (the game's hub-to-grip distance is 0.22 to 0.27) and half height 0.145, so its top is just under the central display
 * (the display's bottom edge is at -0.247, the rim's top at -0.254); a cross spoke, a lower spoke, a hub and an orange 12 o'clock marker.
 */
export const WHEEL_HALF: V2 = [0.26, 0.145];
/** The inner outline of the rim as a share of the outer one. */
export const WHEEL_RIM_INNER = 0.9;
/** Half thickness of the spokes, their reach as a share of the rim's half size, and the hub's half size. */
export const WHEEL_SPOKE_HALF = 0.01;
export const WHEEL_SPOKE_REACH = 0.84;
export const WHEEL_HUB_HALF = 0.032;
/** The 12 o'clock marker: half width and its extent as shares of the half height (it straddles the rim's top). */
export const WHEEL_MARKER_HALF = 0.012;
export const WHEEL_MARKER_SPAN: V2 = [0.8, 1.02];

/**
 * Whether the wheel covers the point (`x`, `y`), in tan units relative to the hub, when it is turned `angleDeg` clockwise (as seen by the
 * driver). The same shapes `paintWheel` draws: the rim ring, the cross spoke, the lower spoke, the hub and the marker.
 */
export function wheelCovers(x: number, y: number, angleDeg: number): boolean {
  const t = (angleDeg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const u = x * c - y * s, v = x * s + y * c; // the point in the wheel's own frame (undo the clockwise turn)
  const [a, b] = WHEEL_HALF;
  const e = (u / a) ** 4 + (v / b) ** 4;
  if (e <= 1 && e >= WHEEL_RIM_INNER ** 4) return true;
  if (Math.abs(v) <= WHEEL_SPOKE_HALF && Math.abs(u) <= a * WHEEL_SPOKE_REACH) return true;
  if (Math.abs(u) <= WHEEL_SPOKE_HALF && v <= 0 && v >= -b * WHEEL_SPOKE_REACH) return true;
  if (Math.abs(u) <= WHEEL_HUB_HALF && Math.abs(v) <= WHEEL_HUB_HALF) return true;
  return Math.abs(u) <= WHEEL_MARKER_HALF && v >= b * WHEEL_MARKER_SPAN[0] && v <= b * WHEEL_MARKER_SPAN[1];
}

/** The share (0..1) of the tan rect `r` that the wheel covers at `angleDeg`, sampled on an `n` x `n` grid. */
export function wheelCoverage(r: TanRect, angleDeg: number, n = 48): number {
  const e = rectEdges(r);
  let hit = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = e.x0 + ((i + 0.5) / n) * r.w, y = e.y0 + ((j + 0.5) / n) * r.h;
    if (wheelCovers(x - WHEEL_CENTRE[0], y - WHEEL_CENTRE[1], angleDeg)) hit++;
  }
  return hit / (n * n);
}

/** A rounded rectangle (a superellipse of order `n`) with half sizes `a` and `b`, counter-clockwise, as `steps` points. */
export function wheelOutline(a: number, b: number, n = 4, steps = 72): V2[] {
  const pts: V2[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI, c = Math.cos(t), s = Math.sin(t);
    pts.push([a * Math.sign(c) * Math.abs(c) ** (2 / n), b * Math.sign(s) * Math.abs(s) ** (2 / n)]);
  }
  return pts;
}

/** The bonnet's paint seen through the windscreen at its lower corners (px x 395..750 left, 1650.. right; on or just above the opening's lower edge). */
export const BONNET_LEFT: readonly V2[] = [[-0.409, -0.0898], [-0.416, -0.07], [-0.36, -0.0655], [-0.28, -0.07], [-0.2, -0.082], [-0.1646, -0.0898]];
export const BONNET_RIGHT: readonly V2[] = [[0.5163, -0.086], [0.5163, -0.08], [0.58, -0.07], [0.7, -0.064], [0.9, -0.06], [1.2, -0.059], [1.2, -0.0875]];

/** Maps tan coordinates of `region` onto a `w` x `h` canvas (y down). */
export function tanMap(region: { x0: number; x1: number; y0: number; y1: number }, w: number, h: number) {
  const sx = w / (region.x1 - region.x0), sy = h / (region.y1 - region.y0);
  return { x: (tx: number) => (tx - region.x0) * sx, y: (ty: number) => (region.y1 - ty) * sy, sx, sy };
}

/** A rect's pixel box on a canvas that covers `region`. */
export function pxBox(r: TanRect, region: { x0: number; x1: number; y0: number; y1: number }, w: number, h: number) {
  const m = tanMap(region, w, h), e = rectEdges(r);
  return { x: m.x(e.x0), y: m.y(e.y1), w: r.w * m.sx, h: r.h * m.sy };
}
