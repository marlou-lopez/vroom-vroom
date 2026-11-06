import { BufferAttribute, BufferGeometry, Color, DoubleSide, Path, Shape, ShapeGeometry, ShaderMaterial, Vector2 } from "three";

/**
 * The windscreen opening of the McLaren 720S GT3 Evo at the user's seat (vertical FOV 44 deg), measured from in-game screenshots.
 * Points are (tan of the horizontal angle, tan of the vertical angle) from the view axis, + = right / up. The frame is fixed to the
 * camera, so it is built in this tangent space and stays right for any window aspect.
 */
const FAR_RIGHT = 3; // the opening runs on to the right past any plausible aspect (the right pillar is outside the 16:9 view)
export const COCKPIT_OPENING: readonly (readonly [number, number])[] = [
  [-0.4938, 0.1796], [-0.4040, 0.1781], [-0.2245, 0.1691], [-0.0449, 0.1631], [0.1347, 0.1571], [0.3142, 0.1541],
  [0.4938, 0.1541], [FAR_RIGHT, 0.1571], [FAR_RIGHT, -0.0898], [0.5163, -0.0860], [0.1047, -0.0883], [-0.1646, -0.0898], [-0.4100, -0.0898],
];
/**
 * The left side window, behind the A-pillar (the same tan space, clockwise). **Measured part:** the three points at the 16:9 view's
 * left edge and the apex, read from the static mask of the camera-locked screenshots: at x = 0 the scene shows from y 488 to 660,
 * narrowing to a point at about (52, 558) (tx -0.679), bounded above by the roll-cage tube / A-pillar's outer edge and below by the door's
 * top (the sill). **Designed part:** everything further left, which no 16:9 screenshot shows: the top edge flattens to the roof edge
 * (ty about 0.14 to 0.15, like the windscreen's top), the sill runs on almost level (-0.10 to -0.115) and the rear edge (a roll-cage
 * tube or the door's rear edge) is a vertical at tx -1.3, outside a 21:9 view (edge at -0.94) but inside a 32:9 one (-1.44).
 */
export const SIDE_WINDOW: readonly (readonly [number, number])[] = [
  [-1.3, 0.15], [-0.95, 0.14], [-0.8, 0.108], [-0.718, 0.0389], [-0.679, -0.0135], [-0.718, -0.0898], [-0.8, -0.1], [-1.3, -0.115],
];
/** Number of points of `SIDE_WINDOW` (the trim shader's uniform has this length). */
const WIN_N = SIDE_WINDOW.length;

/** Half extents of the covered area in tan space: well beyond any view. */
const OUTER_X = 4, OUTER_Y = 3;

/** Distance in front of the camera at which the frame is drawn (m): just beyond the cockpit near plane. */
export const COCKPIT_FRAME_DISTANCE_M = 0.15;

/**
 * The frame as a flat mesh: a big rectangle with the opening and the side window cut out, at depth -`distance` in camera space
 * (positions are (tx, ty) * distance, so it covers the same view angles at any distance).
 */
export function buildCockpitFrameGeometry(distance = COCKPIT_FRAME_DISTANCE_M, opening = COCKPIT_OPENING, windows: readonly (readonly (readonly [number, number])[])[] = [SIDE_WINDOW]): BufferGeometry {
  const shape = new Shape();
  shape.moveTo(-OUTER_X, -OUTER_Y);
  shape.lineTo(OUTER_X, -OUTER_Y);
  shape.lineTo(OUTER_X, OUTER_Y);
  shape.lineTo(-OUTER_X, OUTER_Y);
  shape.closePath();
  const hole = new Path();
  opening.forEach(([x, y], i) => (i === 0 ? hole.moveTo(x, y) : hole.lineTo(x, y)));
  hole.closePath();
  shape.holes.push(hole);
  for (const w of windows) {
    const wh = new Path();
    w.forEach(([x, y], i) => (i === 0 ? wh.moveTo(x, y) : wh.lineTo(x, y)));
    wh.closePath();
    shape.holes.push(wh);
  }
  const g = new ShapeGeometry(shape);
  const pos = g.getAttribute("position");
  for (let i = 0; i < pos.count; i++) pos.setXYZ(i, pos.getX(i) * distance, pos.getY(i) * distance, -distance);
  pos.needsUpdate = true;
  g.computeBoundingSphere();
  return g;
}

/**
 * A thin lit edge along the opening, just outside it (on the trim): a ribbon of `width` tan units whose colour fades from `light` at the
 * opening's edge to nothing. Vertices are the opening's points with the miter-averaged outward normal; positions are scaled like the frame's.
 */
export function buildOpeningEdgeGeometry(distance = COCKPIT_FRAME_DISTANCE_M, opening = COCKPIT_OPENING, width = 0.008, light = "#ffffff", alpha = 0.55): BufferGeometry {
  const n = opening.length;
  let area = 0;
  for (let i = 0; i < n; i++) { const [x0, y0] = opening[i], [x1, y1] = opening[(i + 1) % n]; area += x0 * y1 - x1 * y0; }
  const k = area < 0 ? 1 : -1; // area < 0: clockwise (y up), as the opening is: outward is (-dy, dx); counter-clockwise: (dy, -dx)
  const seg = (i: number): [number, number] => {
    const [x0, y0] = opening[i], [x1, y1] = opening[(i + 1) % n];
    const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1;
    return [(-dy / l) * k, (dx / l) * k];
  };
  const c = new Color(light);
  const pos = new Float32Array(n * 2 * 3), col = new Float32Array(n * 2 * 4);
  for (let i = 0; i < n; i++) {
    const a = seg((i + n - 1) % n), b = seg(i);
    let nx = a[0] + b[0], ny = a[1] + b[1];
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    const [x, y] = opening[i];
    pos.set([x * distance, y * distance, -distance, (x + nx * width) * distance, (y + ny * width) * distance, -distance], i * 6);
    col.set([c.r, c.g, c.b, alpha, c.r, c.g, c.b, 0], i * 8);
  }
  const index: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    index.push(2 * i, 2 * j, 2 * i + 1, 2 * j, 2 * j + 1, 2 * i + 1);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("color", new BufferAttribute(col, 4));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

const FRAME_VERT = `
uniform float uDist;
varying vec2 vT;
void main() {
  vT = position.xy / uDist;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * The trim's look, per pixel in tan space: a base-to-light shade that differs by zone (the roof header is lit near the glass and sinks
 * towards the top, the A-pillar is lit along the glass edge, the dash top catches light along the windscreen's lower edge), with a plain
 * carbon weave on top at low contrast that fades out when its cells get smaller than about three pixels.
 */
const FRAME_FRAG = `
uniform vec3 uBase;
uniform vec3 uLight;
uniform vec2 uWin[WIN_N];
varying vec2 vT;
float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  return length(p - a - ab * clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0));
}
void main() {
  float x = vT.x;
  float y = vT.y;
  float s = 0.25;
  // A-pillar: distance left of the opening's slanted left edge.
  float edgeX = mix(-0.41, -0.4938, clamp((y + 0.09) / 0.27, 0.0, 1.0));
  float d = edgeX - x;
  float pillar = 1.0 - smoothstep(0.0, 0.45, d);
  s = mix(s, 0.10 + 0.5 * pillar * pillar, smoothstep(0.0, 0.01, d));
  // Side window: the pillar, the sill and the roof edge catch light along the window's edge.
  float dw = 9.0;
  for (int i = 0; i < WIN_N; i++) dw = min(dw, segDist(vT, uWin[i], uWin[i == WIN_N - 1 ? 0 : i + 1]));
  s = max(s, 0.5 * (1.0 - smoothstep(0.0, 0.05, dw)));
  // Roof header: lit just above the glass, sinking towards the top.
  float up = smoothstep(0.17, 0.43, y);
  s = mix(s, 0.45 - 0.42 * up, smoothstep(0.15, 0.19, y));
  // Dash top: catches light along the windscreen's lower edge.
  float lit = smoothstep(-0.42, -0.09, y);
  s = mix(s, 0.08 + 0.42 * lit * lit, 1.0 - smoothstep(-0.095, -0.085, y));
  // Carbon weave.
  vec2 p = vT * 150.0;
  vec2 c = floor(p);
  vec2 f = fract(p);
  float chk = mod(c.x + c.y, 2.0);
  float tow = chk < 0.5 ? f.y : f.x;
  float w = (tow - 0.5) * (chk < 0.5 ? 1.0 : -1.0);
  float aa = 1.0 - smoothstep(0.25, 0.5, max(fwidth(p.x), fwidth(p.y)));
  s += w * 0.14 * aa;
  gl_FragColor = vec4(mix(uBase, uLight, clamp(s, 0.0, 1.0)), 1.0);
  #include <colorspace_fragment>
}`;

/** The trim material: opaque, drawn over everything with no depth test (the camera-attached frame). `base` and `light` are CSS colours. */
export function createCockpitFrameMaterial(base: string, light: string, distance = COCKPIT_FRAME_DISTANCE_M): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uBase: { value: new Color(base) }, uLight: { value: new Color(light) }, uDist: { value: distance }, uWin: { value: SIDE_WINDOW.map(([x, y]) => new Vector2(x, y)) } },
    vertexShader: FRAME_VERT,
    fragmentShader: FRAME_FRAG.replaceAll("WIN_N", String(WIN_N)),
    side: DoubleSide,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
}
