import {
  BufferAttribute, CanvasTexture, Color, Group, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, ShaderMaterial, ShapeGeometry, Shape, type BufferGeometry, type Texture,
} from "three";
import type { RpmLimits } from "../../../lib/shiftLights";
import { SIDE_WINDOW, buildCockpitFrameGeometry, buildOpeningEdgeGeometry, createCockpitFrameMaterial } from "./cockpitFrame";
import {
  BONNET_LEFT, BONNET_RIGHT, DASH_PX, DASH_REGION, DISPLAY, DISPLAY_PX, MIRROR, MIRROR_HOUSING, MIRROR_HOUSING_PX, MIRROR_PX, SECOND_DISPLAY, SECOND_PX,
  WHEEL_CENTRE, WHEEL_PLANE, WHEEL_PX, rectEdges, type TanRect, type V2,
} from "./cockpitLayout";
import {
  WEAVE_TILE_PX, dashKey, deltaKey, mixHex, paintDash, paintDashTop, paintDelta, paintMirrorFallback, paintMirrorHousing, paintWeaveTile, paintWheel,
  type CockpitPalette, type Ctx2D,
} from "./cockpitPaint";
import { wheelAngleDeg, type DashValues } from "./dashValues";

/**
 * Everything the driver sees of the car in the cockpit view (#101), as one camera-attached group: the trim around the windscreen
 * (roof header, A-pillar, dash top, carbon shading and a lit edge), the bonnet at the lower corners, the dash-top shapes, the mirror's
 * housing and glass, the central display, the second display (delta to the reference)  and the steering wheel (a rounded-rectangle rim with a cross spoke, a lower spoke, a hub and an orange 12 o'clock marker).
 * The trim has two openings: the windscreen and a left side window.
 * All original, placed by the tan-space layout in `cockpitLayout.ts`, which was measured from the user's screenshots.
 *
 * Draw calls: 10 (frame, edge, side window's edge, bonnet, dash top, mirror housing, mirror glass, two displays, wheel; the mirror's own pass renders the scene
 * again, see `cockpitMirror.ts`). The pieces are drawn in order with the depth test off. The three static textures are painted once,
 * the two displays only when a shown value changes; the wheel only turns.
 */

/** Distance in front of the camera (m): the same as the windscreen frame, beyond the cockpit near plane. */
export const DASH_DISTANCE_M = 0.15;
const ORDER = 1000;
/** The wheel is drawn last, in front of the dash top, the displays and the mirror (a real wheel is in front of them). All are transparent-queue meshes sorted by `renderOrder`; the opaque trim and bonnet are drawn before any of them. */
const WHEEL_ORDER = 8;

export interface CockpitDash {
  /** Attach to the camera; draws nothing when `visible` is false. */
  root: Group;
  update(v: DashValues, limits: RpmLimits | null): void;
  dispose(): void;
}

interface Painted { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D | null; texture: CanvasTexture }

function makeCanvas([w, h]: V2): Painted {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return { canvas, ctx, texture };
}

/** A shape with a colour gradient in y, for the bonnet: `top` at its highest point, `bottom` at its lowest (linear in y, so exact on any triangulation). */
export function shadedShapes(polys: readonly (readonly V2[])[], top: string, bottom: string, distance: number): BufferGeometry {
  const shapes = polys.map((p) => { const s = new Shape(); p.forEach(([x, y], i) => (i === 0 ? s.moveTo(x, y) : s.lineTo(x, y))); s.closePath(); return s; });
  const g = new ShapeGeometry(shapes);
  const pos = g.getAttribute("position");
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pos.count; i++) { lo = Math.min(lo, pos.getY(i)); hi = Math.max(hi, pos.getY(i)); }
  const a = new Color(top), b = new Color(bottom), c = new Color();
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    c.copy(b).lerp(a, hi > lo ? (pos.getY(i) - lo) / (hi - lo) : 1).toArray(colors, 3 * i);
    pos.setXYZ(i, pos.getX(i) * distance, pos.getY(i) * distance, -distance);
  }
  g.setAttribute("color", new BufferAttribute(colors, 3));
  pos.needsUpdate = true;
  g.computeBoundingSphere();
  return g;
}

/**
 * Builds the cockpit. `mirror` is the live mirror's picture, or null for a still one. `distance` is how far in front of the camera
 * everything is drawn (tan-space sizes are scaled by it).
 */
export function createCockpitDash(pal: CockpitPalette, mirror: Texture | null, distance = DASH_DISTANCE_M): CockpitDash {
  const root = new Group();
  const owned: { dispose(): void }[] = [];
  const basic = (o: ConstructorParameters<typeof MeshBasicMaterial>[0]) => {
    const m = new MeshBasicMaterial({ depthTest: false, depthWrite: false, fog: false, ...o });
    owned.push(m);
    return m;
  };
  const add = (geometry: BufferGeometry, material: MeshBasicMaterial | ShaderMaterial, order: number): Mesh => {
    owned.push(geometry);
    const m = new Mesh(geometry, material);
    m.renderOrder = ORDER + order;
    m.frustumCulled = false;
    root.add(m);
    return m;
  };
  /** A textured plane over the tan rect `r`, optionally mirrored left-right. */
  const plane = (r: TanRect, map: Texture, order: number, flipU = false): Mesh => {
    const g = new PlaneGeometry(1, 1);
    if (flipU) { const uv = g.getAttribute("uv"); for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i)); }
    const m = add(g, basic({ map, transparent: true }), order);
    m.position.set(r.cx * distance, r.cy * distance, -distance);
    m.scale.set(r.w * distance, r.h * distance, 1);
    return m;
  };

  // The carbon weave tile, shared by the painted parts.
  const tile = document.createElement("canvas");
  tile.width = tile.height = WEAVE_TILE_PX;
  const tileCtx = tile.getContext("2d");
  if (tileCtx) paintWeaveTile(tileCtx as Ctx2D);
  const weave = tileCtx ? tileCtx.createPattern(tile, "repeat") : null;

  // 1. The trim around the windscreen, 2. its lit edge, 3. the bonnet in the car's paint.
  const frameMat = createCockpitFrameMaterial(pal.interior, pal.trim, distance);
  owned.push(frameMat);
  add(buildCockpitFrameGeometry(distance), frameMat, 0);
  const edgeMat = basic({ vertexColors: true, transparent: true });
  add(buildOpeningEdgeGeometry(distance, undefined, 0.008, pal.trim), edgeMat, 1);
  add(buildOpeningEdgeGeometry(distance, SIDE_WINDOW, 0.008, pal.trim), edgeMat, 1);
  add(shadedShapes([BONNET_LEFT, BONNET_RIGHT], mixHex(pal.bonnet, "#ffffff", 0.25), mixHex(pal.bonnet, "#000000", 0.5), distance), basic({ vertexColors: true }), 2);

  // 4. Dash top (binnacle, switch pod, second display's shroud).
  const top = makeCanvas(DASH_PX);
  if (top.ctx) paintDashTop(top.ctx as Ctx2D, DASH_PX[0], DASH_PX[1], pal, weave);
  top.texture.needsUpdate = true;
  owned.push(top.texture);
  const reg = DASH_REGION;
  plane({ cx: (reg.x0 + reg.x1) / 2, cy: (reg.y0 + reg.y1) / 2, w: reg.x1 - reg.x0, h: reg.y1 - reg.y0 }, top.texture, 3);

  // 5. Mirror housing, 6. the glass (live picture flipped, or a still one).
  const housing = makeCanvas(MIRROR_HOUSING_PX);
  const hb = rectEdges(MIRROR_HOUSING), gb = rectEdges(MIRROR);
  if (housing.ctx) {
    paintMirrorHousing(housing.ctx as Ctx2D, MIRROR_HOUSING_PX[0], MIRROR_HOUSING_PX[1], {
      x: (gb.x0 - hb.x0) / MIRROR_HOUSING.w, y: (hb.y1 - gb.y1) / MIRROR_HOUSING.h, w: MIRROR.w / MIRROR_HOUSING.w, h: MIRROR.h / MIRROR_HOUSING.h,
    }, pal, weave);
  }
  housing.texture.needsUpdate = true;
  owned.push(housing.texture);
  plane(MIRROR_HOUSING, housing.texture, 4);
  let glass: Texture;
  if (mirror) {
    glass = mirror;
  } else {
    const still = makeCanvas(MIRROR_PX);
    if (still.ctx) paintMirrorFallback(still.ctx as Ctx2D, MIRROR_PX[0], MIRROR_PX[1], pal);
    still.texture.needsUpdate = true;
    owned.push(still.texture);
    glass = still.texture;
  }
  plane(MIRROR, glass, 5, true);

  // 7. Central display, 8. second display.
  const dash = makeCanvas(DISPLAY_PX);
  plane(DISPLAY, dash.texture, 6);
  owned.push(dash.texture);
  const second = makeCanvas(SECOND_PX);
  plane(SECOND_DISPLAY, second.texture, 7);
  owned.push(second.texture);

  // 9. The wheel: one textured plane turned about the hub. It is drawn after everything else, as a real wheel is in front of
  // the displays; its rim and spokes are slim so the readouts show through its openings.
  const wheel = makeCanvas(WHEEL_PX);
  if (wheel.ctx) paintWheel(wheel.ctx as Ctx2D, WHEEL_PX[0], WHEEL_PX[1], pal);
  wheel.texture.needsUpdate = true;
  owned.push(wheel.texture);
  const pivot = new Group();
  pivot.position.set(WHEEL_CENTRE[0] * distance, WHEEL_CENTRE[1] * distance, -distance);
  root.add(pivot);
  const wg = new PlaneGeometry(WHEEL_PLANE[0] * distance, WHEEL_PLANE[1] * distance);
  owned.push(wg);
  const wm = new Mesh(wg, basic({ map: wheel.texture, transparent: true }));
  wm.renderOrder = ORDER + WHEEL_ORDER;
  wm.frustumCulled = false;
  pivot.add(wm);
  root.visible = false;

  let lastDash = "", lastDelta = "";
  return {
    root,
    update(v, limits) {
      pivot.rotation.z = -(wheelAngleDeg(v.steering, v.steeringRangeDeg) * Math.PI) / 180; // + = right = clockwise seen from the driver
      const key = dashKey(v, limits);
      if (key !== lastDash && dash.ctx) {
        lastDash = key;
        paintDash(dash.ctx as Ctx2D, DISPLAY_PX[0], DISPLAY_PX[1], v, limits, pal);
        dash.texture.needsUpdate = true;
      }
      const dk = deltaKey(v);
      if (dk !== lastDelta && second.ctx) {
        lastDelta = dk;
        paintDelta(second.ctx as Ctx2D, SECOND_PX[0], SECOND_PX[1], v, pal);
        second.texture.needsUpdate = true;
      }
    },
    dispose() {
      for (const o of owned) o.dispose();
    },
  };
}
