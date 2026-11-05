import {
  BufferAttribute, BufferGeometry, CircleGeometry, InterleavedBuffer, InterleavedBufferAttribute, Color, Float32BufferAttribute, Mesh, MeshBasicMaterial, DoubleSide, OrthographicCamera, RingGeometry, Scene as ThreeScene, WebGLRenderer,
} from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { zoomScale } from "../../../lib/camera";
import { gainStrength } from "../../../lib/gainLoss";
import type { XY } from "../../../lib/geo";
import {
  AHEAD_DIM, CAR_R_PX, LINE_DIM, CASING_PX, CHEVRON_BELOW_M, CHEVRON_LEN_PX, CHEVRON_WID_PX, EDGE_MEASURED_LIFT, EDGE_PX, KERB_RED, KERB_STRIPE_M, KERB_W_M, KERB_WHITE, GAIN_PX, LAP_PX, REF_PX, SURFACE_DIM, dashWorld, gainExtraM, mixSrgb, readColors,
  type Frame, type GainStyle, type Renderer, type RendererEvents,
} from "./renderer";
import { gainPositions, progressSplit, type GainLine, type Scene } from "./scene";

function positions(xy: XY): Float32Array {
  const out = new Float32Array(xy.x.length * 3);
  for (let i = 0; i < xy.x.length; i++) {
    out[3 * i] = xy.x[i];
    out[3 * i + 1] = xy.y[i];
  }
  return out;
}

/** Rewrites every segment of a line geometry from point positions (x, y, z per point) and queues a full upload. */
function writeSegments(g: LineGeometry, pos: Float32Array) {
  const b = (g.getAttribute("instanceStart") as InterleavedBufferAttribute).data as InterleavedBuffer;
  const a = b.array as Float32Array;
  // Segment i is stored as point i then point i + 1: six floats, exactly pos[3i .. 3i + 6).
  for (let i = 0; i < pos.length / 3 - 1; i++) a.set(pos.subarray(3 * i, 3 * i + 6), 6 * i);
  b.clearUpdateRanges();
  b.needsUpdate = true;
}

/** Triangles filling the band between two same-length lines: vertex 2i on `a`, 2i + 1 on `b`; 6 indices per segment. */
function ribbon(a: XY, b: XY, colors: Float32Array): BufferGeometry {
  const n = Math.min(a.x.length, b.x.length);
  const pos = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    pos[6 * i] = a.x[i]; pos[6 * i + 1] = a.y[i]; pos[6 * i + 2] = -0.1;
    pos[6 * i + 3] = b.x[i]; pos[6 * i + 4] = b.y[i]; pos[6 * i + 5] = -0.1;
  }
  const col = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const c = colors.subarray(3 * i, 3 * i + 3);
    col.set(c, 6 * i);
    col.set(c, 6 * i + 3);
  }
  const idx = new Uint32Array(Math.max(n - 1, 0) * 6);
  for (let i = 0; i < n - 1; i++) idx.set([2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2], 6 * i);
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new Float32BufferAttribute(col, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  return g;
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
  const makeMat = (color: string, px: number, vertexColors = false, worldUnits = false) => {
    const m = new LineMaterial({ color: new Color(color).getHex(), linewidth: px, worldUnits, vertexColors });
    lineMats.push(m);
    baseWidth.set(m, px);
    return m;
  };
  // Per-vertex colours: telemetry-measured stretches are a bit brighter than filled-in ones (#36).
  const edgeMat = makeMat("#ffffff", EDGE_PX, true);
  /** Kerbs: world-unit width, so they follow the zoom with no per-frame work; excluded from the px-width rescale in draw. */
  const kerbMat = makeMat("#ffffff", KERB_W_M, true, true);
  /** Edges along the track-surface band's borders, shown in Track style instead of the ±7 m stand-in edges. */
  const surfaceEdgeMat = makeMat(colors.line, EDGE_PX);
  const casingMat = makeMat(colors.bg, CASING_PX);
  // Lines are dimmed toward the background so the cars (full colour) read as distinct from their own line.
  const dim = (c: string) => "#" + new Color(c).lerp(new Color(colors.bg), LINE_DIM).getHexString();
  const refMat = makeMat(dim(colors.comparison), REF_PX);
  const lapMat = makeMat(dim(colors.you), LAP_PX);
  const aheadDim = (c: string) => "#" + new Color(c).lerp(new Color(colors.bg), AHEAD_DIM).getHexString();
  const refAheadMat = makeMat(aheadDim(colors.comparison), REF_PX / 2);
  const lapAheadMat = makeMat(aheadDim(colors.you), LAP_PX / 2);
  // The reference line is dashed (the casing too, or its gaps would show a background-coloured stripe); sizes are set in draw.
  const dashedMats = [casingMat, refMat, refAheadMat];
  for (const m of dashedMats) m.dashed = true;
  // Gain/loss line (#59): per-vertex colours on a white material, one tone the whole lap (no split at the car).
  const gainMat = makeMat("#ffffff", GAIN_PX, true);
  let lines: Line2[] = [];
  let aheadLines: Line2[] = [];
  let showAhead = true;
  let edgeDebug = false;
  let edgeLines: { geom: LineGeometry; measured: Uint8Array | null; n: number }[] = [];
  let gainStyle: GainStyle = "side";
  /** Track-surface style: one ribbon, the same tone the whole lap (no split at the car). */
  // Dithering hides the 8-bit steps in long, dark gradients.
  const surfaceMat = new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, depthTest: false, dithering: true });
  let surfaceMesh: Mesh | null = null;
  let gainLine: Line2 | null = null;
  let gainSrc: { centre: XY; line: GainLine; pos: Float32Array } | null = null;
  /** The extra offset (m) the gain line's points were last built with; NaN forces a rebuild. */
  let gainExtra = NaN;
  let lineGeoms: LineGeometry[] = [];

  /**
   * A line drawn only up to the car: instanceCount covers the driven segments and the last one's end is pulled back
   * to the car. Only that one segment's end floats are re-uploaded each draw.
   */
  interface Driven { geoms: LineGeometry[]; orig: Float32Array; n: number; moved: number; dist: Float32Array | null }
  const makeDriven = (xy: XY, mats: [LineMaterial, number][]): Driven => {
    const pos = positions(xy);
    const geoms: LineGeometry[] = [];
    for (const [m, order] of mats) {
      const geom = new LineGeometry();
      geom.setPositions(pos);
      const line = new Line2(geom, m);
      if (m.dashed) line.computeLineDistances();
      line.frustumCulled = false;
      line.renderOrder = order;
      scene.add(line);
      lines.push(line); lineGeoms.push(geom);
      geoms.push(geom);
    }
    // Each geometry has its own buffer; one original copy serves them all (positions, and the dash distances if dashed).
    const dist = mats.some(([m]) => m.dashed) && geoms.length ? (geoms[0].getAttribute("instanceDistanceEnd") as InterleavedBufferAttribute).data.array as Float32Array : null;
    return { geoms, orig: pos, n: xy.x.length, moved: -1, dist: dist && dist.slice() };
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
      if (d.dist) {
        // Dashes run on the distance from the lap start: shorten this segment's end distance with its end, or its dashes would squeeze.
        const db = (g.getAttribute("instanceDistanceEnd") as InterleavedBufferAttribute).data as InterleavedBuffer;
        const da = db.array as Float32Array;
        if (d.moved >= 0 && d.moved !== segment) { da[2 * d.moved + 1] = d.dist[2 * d.moved + 1]; db.addUpdateRange(2 * d.moved + 1, 1); }
        da[2 * segment + 1] = da[2 * segment] + fraction * (d.dist[2 * segment + 1] - da[2 * segment]);
        db.addUpdateRange(2 * segment + 1, 1);
        db.needsUpdate = true;
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

  /**
   * Per-point colours: the background toward green (gaining) or red (losing) by gainStrength, then `dim` toward the
   * background. "About even" shows no colour at all, in both the side line and the track surface.
   */
  const gainColors = (rate: Float64Array, dim: number): Float32Array => {
    const gain = new Color(colors.gain), loss = new Color(colors.loss), bg = new Color(colors.bg);
    const out = new Float32Array(rate.length * 3);
    const c = new Color();
    for (let i = 0; i < rate.length; i++) {
      const t = gainStrength(rate[i]);
      c.copy(bg).lerp(t > 0 ? loss : gain, Math.abs(t)).lerp(bg, dim);
      out[3 * i] = c.r; out[3 * i + 1] = c.g; out[3 * i + 2] = c.b;
    }
    return out;
  };

  const applyVisibility = () => {
    const side = gainStyle === "side", surface = gainStyle === "track";
    for (const l of aheadLines) l.visible = showAhead;
    if (gainLine) gainLine.visible = side;
    if (surfaceMesh) surfaceMesh.visible = surface;
    // The band is wider than the stand-in edges, so it gets edges on its own borders.
    edgeMat.visible = !surface;
    surfaceEdgeMat.visible = surface;
  };

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
    refDriven = null; lapDriven = null; gainLine = null; gainSrc = null;
    gainExtra = NaN;
    if (surfaceMesh) { scene.remove(surfaceMesh); surfaceMesh.geometry.dispose(); }
    surfaceMesh = null;
  };
  let lastW = -1, lastH = -1, lastDpr = -1;

  // Plain line colour everywhere; in the debug view the measured stretches get a subtle sRGB tint.
  const recolourEdges = () => {
    const plain = new Color(colors.line), tint = new Color(mixSrgb(colors.line, colors.text, EDGE_MEASURED_LIFT));
    for (const e of edgeLines) {
      const out = new Float32Array(e.n * 3);
      for (let i = 0; i < e.n; i++) {
        const c = edgeDebug && e.measured && e.measured[i] ? tint : plain;
        out[3 * i] = c.r; out[3 * i + 1] = c.g; out[3 * i + 2] = c.b;
      }
      e.geom.setColors(out);
    }
  };

  return {
    setScene(s: Scene) {
      clearLines();
      const add = (xy: XY, mat: LineMaterial, order: number) => {
        const geom = new LineGeometry();
        geom.setPositions(positions(xy));
        const line = new Line2(geom, mat);
        if (mat.dashed) line.computeLineDistances();
        line.frustumCulled = false;
        line.renderOrder = order;
        scene.add(line);
        lines.push(line); lineGeoms.push(geom);
        return line;
      };
      edgeLines = [];
      for (const side of [0, 1]) {
        const e = add(s.edges[side], edgeMat, 1);
        edgeLines.push({ geom: e.geometry as LineGeometry, measured: s.edgeMeasured ? s.edgeMeasured[side] : null, n: s.edges[side].x.length });
      }
      recolourEdges();
      const red = new Color(KERB_RED), white = new Color(KERB_WHITE);
      for (const k of s.kerbs) {
        const m = k.xy.x.length;
        const col = new Float32Array(m * 3);
        for (let i = 0; i < m; i++) {
          const c = Math.floor(i / KERB_STRIPE_M) % 2 === 0 ? red : white;
          col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b;
        }
        const line = add(k.xy, kerbMat, 1);
        (line.geometry as LineGeometry).setColors(col);
      }
      add(s.surface[0], surfaceEdgeMat, 1);
      add(s.surface[1], surfaceEdgeMat, 1);
      aheadLines = [add(s.ref, refAheadMat, 2), add(s.lap, lapAheadMat, 3)];
      refDriven = makeDriven(s.ref, [[casingMat, 4], [refMat, 5]]);
      lapDriven = makeDriven(s.lap, [[lapMat, 6]]);
      // Gain line: placeholder points until the first draw knows the zoom (gainExtra is NaN).
      if (s.centre.x.length >= 2) {
        gainSrc = { centre: s.centre, line: s.gain, pos: new Float32Array(s.centre.x.length * 3) };
        gainLine = add(s.centre, gainMat, 1);
        (gainLine.geometry as LineGeometry).setColors(gainColors(s.gain.rate, 0));
        // Track-surface style: drawn first (renderOrder 0), under the edges and racing lines.
        surfaceMesh = new Mesh(ribbon(s.surface[0], s.surface[1], gainColors(s.gain.rate, SURFACE_DIM)), surfaceMat);
        surfaceMesh.frustumCulled = false;
        surfaceMesh.renderOrder = 0;
        scene.add(surfaceMesh);
      }
      applyVisibility();
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
      for (const m of lineMats) if (m !== kerbMat) m.linewidth = (baseWidth.get(m) ?? 1) * z;
      for (const m of carMeshes) m.scale.set(unit * z, unit * z, 1);
      const { dash, gap } = dashWorld(c.widthM, v.w, z);
      for (const m of dashedMats) { m.dashSize = dash; m.gapSize = gap; }
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
      // The gain line keeps a fixed screen gap, so its points change only when the zoom does (not on pan or rotate).
      if (gainLine && gainSrc && gainStyle === "side") {
        const extra = gainExtraM(c.widthM, v.w, z);
        if (extra !== gainExtra) {
          gainExtra = extra;
          writeSegments(gainLine.geometry as LineGeometry, gainPositions(gainSrc.centre, gainSrc.line, extra, gainSrc.pos));
        }
      }
      gl.render(scene, camera);
    },
    setAheadVisible(visible: boolean) {
      showAhead = visible;
      applyVisibility();
    },
    setEdgeDebug(on: boolean) {
      if (on === edgeDebug) return;
      edgeDebug = on;
      recolourEdges();
    },
    setGainStyle(style: GainStyle) {
      gainStyle = style;
      applyVisibility();
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
      surfaceMat.dispose();
      for (const m of carMeshes) { m.geometry.dispose(); (m.material as MeshBasicMaterial).dispose(); }
      gl.dispose();
      try { gl.forceContextLoss(); } catch { /* context already lost */ }
      canvas.remove();
    },
  };
}
