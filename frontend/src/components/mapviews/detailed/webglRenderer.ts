import {
  BufferGeometry, CircleGeometry, InterleavedBuffer, InterleavedBufferAttribute, Color, Float32BufferAttribute, Mesh, MeshBasicMaterial, DoubleSide, OrthographicCamera, RingGeometry, Scene as ThreeScene, WebGLRenderer,
} from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { zoomScale } from "../../../lib/camera";
import type { XY } from "../../../lib/geo";
import { AHEAD_DIM, CAR_R_PX, LINE_DIM, CASING_PX, CHEVRON_BELOW_M, CHEVRON_LEN_PX, CHEVRON_WID_PX, EDGE_PX, LAP_PX, REF_PX, readColors, type Frame, type Renderer, type RendererEvents } from "./renderer";
import { progressSplit, type Scene } from "./scene";

function positions(xy: XY): Float32Array {
  const out = new Float32Array(xy.x.length * 3);
  for (let i = 0; i < xy.x.length; i++) {
    out[3 * i] = xy.x[i];
    out[3 * i + 1] = xy.y[i];
  }
  return out;
}

/** Isosceles triangle in px units centred on the origin, pointing +y. */
function chevron(len: number, wid: number): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute([0, len / 2, 0, -wid / 2, -len / 2, 0, wid / 2, -len / 2, 0], 3));
  g.setIndex([0, 1, 2]);
  return g;
}

export function createWebglRenderer(host: HTMLElement, events: RendererEvents): Renderer {
  const colors = readColors(host);
  const gl = new WebGLRenderer({ antialias: true, alpha: true });
  gl.setClearColor(0x000000, 0);
  const canvas = gl.domElement;
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  host.appendChild(canvas);
  // preventDefault on "lost" tells the browser we want the context back.
  const onLost = (e: Event) => { e.preventDefault(); events.onContextLost(); };
  const onRestored = () => events.onContextRestored();
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  let restoreTimer = 0;

  const scene = new ThreeScene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  camera.position.z = 10;

  const lineMats: LineMaterial[] = [];
  /** Base width (px) of each line material; the drawn width is this times zoomScale. */
  const baseWidth = new Map<LineMaterial, number>();
  const makeMat = (color: string, px: number) => {
    const m = new LineMaterial({ color: new Color(color).getHex(), linewidth: px, worldUnits: false });
    lineMats.push(m);
    baseWidth.set(m, px);
    return m;
  };
  const edgeMat = makeMat(colors.line, EDGE_PX);
  const casingMat = makeMat(colors.bg, CASING_PX);
  // Lines are dimmed toward the background so the cars (full colour) read as distinct from their own line.
  const dim = (c: string) => "#" + new Color(c).lerp(new Color(colors.bg), LINE_DIM).getHexString();
  const refMat = makeMat(dim(colors.comparison), REF_PX);
  const lapMat = makeMat(dim(colors.you), LAP_PX);
  const aheadDim = (c: string) => "#" + new Color(c).lerp(new Color(colors.bg), AHEAD_DIM).getHexString();
  const refAheadMat = makeMat(aheadDim(colors.comparison), REF_PX / 2);
  const lapAheadMat = makeMat(aheadDim(colors.you), LAP_PX / 2);
  let lines: Line2[] = [];
  let aheadLines: Line2[] = [];
  let showAhead = true;
  let lineGeoms: LineGeometry[] = [];

  /**
   * A line drawn only up to the car: instanceCount covers the driven segments and the last one's end is pulled back
   * to the car. Only that one segment's end floats are re-uploaded each draw.
   */
  interface Driven { geoms: LineGeometry[]; orig: Float32Array; n: number; moved: number }
  const makeDriven = (xy: XY, mats: [LineMaterial, number][]): Driven => {
    const pos = positions(xy);
    const geoms: LineGeometry[] = [];
    for (const [m, order] of mats) {
      const geom = new LineGeometry();
      geom.setPositions(pos);
      const line = new Line2(geom, m);
      line.frustumCulled = false;
      line.renderOrder = order;
      scene.add(line);
      lines.push(line); lineGeoms.push(geom);
      geoms.push(geom);
    }
    // Each geometry has its own buffer; one original copy serves them all.
    return { geoms, orig: pos, n: xy.x.length, moved: -1 };
  };
  const setProgress = (d: Driven, dist: number) => {
    if (d.n < 2) return;
    const { segment, fraction } = progressSplit(dist, d.n);
    const o = d.orig;
    for (const g of d.geoms) {
      const b = (g.getAttribute("instanceEnd") as InterleavedBufferAttribute).data as InterleavedBuffer;
      const a = b.array as Float32Array;
      if (d.moved >= 0 && d.moved !== segment) {
        const k = d.moved * 6 + 3;
        a[k] = o[3 * (d.moved + 1)]; a[k + 1] = o[3 * (d.moved + 1) + 1];
        b.addUpdateRange(k, 2);
      }
      const k = segment * 6 + 3, s = 3 * segment, e = 3 * (segment + 1);
      a[k] = o[s] + fraction * (o[e] - o[s]);
      a[k + 1] = o[s + 1] + fraction * (o[e + 1] - o[s + 1]);
      b.addUpdateRange(k, 2);
      b.needsUpdate = true;
      g.instanceCount = segment + 1;
    }
    d.moved = segment;
  };
  let refDriven: Driven | null = null, lapDriven: Driven | null = null;

  // Cars are built in px units and scaled by (1 / px-per-metre) each draw so they stay constant on screen.
  const refFill = new Mesh(new CircleGeometry(CAR_R_PX, 24), new MeshBasicMaterial({ color: new Color(colors.bg) }));
  const refRing = new Mesh(new RingGeometry(CAR_R_PX - 1.5, CAR_R_PX, 24), new MeshBasicMaterial({ color: new Color(colors.comparison) }));
  const lapDot = new Mesh(new CircleGeometry(CAR_R_PX, 24), new MeshBasicMaterial({ color: new Color(colors.you) }));
  // Chevrons: fill 12 x 9 px; the outline is a larger triangle drawn underneath (1 px lap, 1.5 px ref).
  const mat = (c: string) => new MeshBasicMaterial({ color: new Color(c), side: DoubleSide });
  const lapChevOut = new Mesh(chevron(CHEVRON_LEN_PX + 3, CHEVRON_WID_PX + 2.5), mat(colors.text));
  const lapChev = new Mesh(chevron(CHEVRON_LEN_PX, CHEVRON_WID_PX), mat(colors.you));
  const refChevOut = new Mesh(chevron(CHEVRON_LEN_PX + 4.5, CHEVRON_WID_PX + 3.5), mat(colors.comparison));
  const refChev = new Mesh(chevron(CHEVRON_LEN_PX, CHEVRON_WID_PX), mat(colors.bg));
  refChevOut.renderOrder = 10; refChev.renderOrder = 11; lapChevOut.renderOrder = 12; lapChev.renderOrder = 13;
  const dotMeshes = [refFill, refRing, lapDot];
  const chevMeshes = [refChevOut, refChev, lapChevOut, lapChev];
  const carMeshes = [...dotMeshes, ...chevMeshes];
  refFill.renderOrder = 10; refRing.renderOrder = 11; lapDot.renderOrder = 12;
  for (const m of carMeshes) {
    (m.material as MeshBasicMaterial).depthTest = false;
    scene.add(m);
  }

  const clearLines = () => {
    for (const l of lines) scene.remove(l);
    for (const g of lineGeoms) g.dispose();
    lines = []; lineGeoms = [];
    refDriven = null; lapDriven = null;
  };
  let lastW = -1, lastH = -1, lastDpr = -1;

  return {
    setScene(s: Scene) {
      clearLines();
      const add = (xy: XY, mat: LineMaterial, order: number) => {
        const geom = new LineGeometry();
        geom.setPositions(positions(xy));
        const line = new Line2(geom, mat);
        line.frustumCulled = false;
        line.renderOrder = order;
        scene.add(line);
        lines.push(line); lineGeoms.push(geom);
        return line;
      };
      add(s.edges[0], edgeMat, 1);
      add(s.edges[1], edgeMat, 1);
      aheadLines = [add(s.ref, refAheadMat, 2), add(s.lap, lapAheadMat, 3)];
      for (const l of aheadLines) l.visible = showAhead;
      refDriven = makeDriven(s.ref, [[casingMat, 4], [refMat, 5]]);
      lapDriven = makeDriven(s.lap, [[lapMat, 6]]);
    },
    resize(v, dpr) {
      if (v.w === lastW && v.h === lastH && dpr === lastDpr) return;
      lastW = v.w; lastH = v.h; lastDpr = dpr;
      gl.setPixelRatio(dpr);
      gl.setSize(v.w, v.h, false);
      for (const m of lineMats) m.resolution.set(v.w, v.h);
    },
    draw(f: Frame) {
      const { camera: c, viewport: v } = f;
      const hw = c.widthM / 2, hh = (c.widthM * v.h) / v.w / 2;
      camera.left = -hw; camera.right = hw; camera.top = hh; camera.bottom = -hh;
      camera.position.set(c.cx, c.cy, 10);
      // worldToScreen turns the world counter-clockwise by `rotation`; turning the camera by -rotation is the same view.
      camera.rotation.z = -c.rotation;
      camera.updateProjectionMatrix();
      const unit = c.widthM / v.w; // metres per px
      // Lines and cars get a bit thicker as you zoom in (1x at 300 m wide, 1.8x at 20 m).
      const z = zoomScale(c.widthM);
      for (const m of lineMats) m.linewidth = (baseWidth.get(m) ?? 1) * z;
      for (const m of carMeshes) m.scale.set(unit * z, unit * z, 1);
      refFill.position.set(f.refCar.x, f.refCar.y, 0.5);
      refRing.position.set(f.refCar.x, f.refCar.y, 0.6);
      lapDot.position.set(f.lapCar.x, f.lapCar.y, 0.7);
      const chevrons = c.widthM < CHEVRON_BELOW_M;
      for (const m of dotMeshes) m.visible = !chevrons;
      for (const m of chevMeshes) m.visible = chevrons;
      if (chevrons) {
        // Modelled pointing +y, so a heading of pi/2 (north) needs no turn; the camera rotation is applied by the view.
        for (const m of [lapChevOut, lapChev]) { m.position.set(f.lapCar.x, f.lapCar.y, m === lapChev ? 0.8 : 0.75); m.rotation.z = f.lapHeading - Math.PI / 2; }
        for (const m of [refChevOut, refChev]) { m.position.set(f.refCar.x, f.refCar.y, m === refChev ? 0.6 : 0.55); m.rotation.z = f.refHeading - Math.PI / 2; }
      }
      if (refDriven) setProgress(refDriven, f.refDist);
      if (lapDriven) setProgress(lapDriven, f.lapDist);
      gl.render(scene, camera);
    },
    setAheadVisible(visible: boolean) {
      showAhead = visible;
      for (const l of aheadLines) l.visible = visible;
    },
    simulateContextLoss() {
      const ext = gl.getContext().getExtension("WEBGL_lose_context");
      if (!ext) return false;
      ext.loseContext();
      window.clearTimeout(restoreTimer);
      restoreTimer = window.setTimeout(() => { try { ext.restoreContext(); } catch { /* already gone */ } }, 1000);
      return true;
    },
    destroy() {
      window.clearTimeout(restoreTimer);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      clearLines();
      for (const m of lineMats) m.dispose();
      for (const m of carMeshes) { m.geometry.dispose(); (m.material as MeshBasicMaterial).dispose(); }
      gl.dispose();
      try { gl.forceContextLoss(); } catch { /* context already lost */ }
      canvas.remove();
    },
  };
}
