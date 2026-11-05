import {
  AmbientLight, BoxGeometry, BufferAttribute, BufferGeometry, Color, DirectionalLight, Fog, Group, HemisphereLight, Mesh, MeshLambertMaterial,
  PerspectiveCamera, Scene as ThreeScene, Vector3, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { CarDims } from "../../../api/types";
import type { Viewport } from "../../../lib/camera";
import type { XY } from "../../../lib/geo";
import { AHEAD_DIM, EDGE_PX, KERB_RED, KERB_WHITE, LAP_PX, LINE_DIM, REF_PX, mixSrgb, readColors } from "../detailed/renderer";
import { OrbitRig, ChaseRig, TopRig, type CameraFrame, type CameraRig, type ViewMode } from "./cameraRigs";
import { toThree } from "./coords";
import { buildKerbMesh, buildLinePositions, buildRibbonMesh } from "./geometry";
import type { CarPose } from "./pose";
import { carEuler } from "./pose";
import type { RibbonEvents, RibbonFrame, RibbonRenderer, ScreenPoint } from "./types";

/** Lifts (m, before the vertical exaggeration) that keep each layer clear of the one below it. */
const EDGE_LIFT = 0.02, KERB_LIFT = 0.03, AHEAD_LIFT = 0.05, DRIVEN_LIFT = 0.07;
const CAR_BODY_H = 0.6, CAR_BODY_Y = 0.15, CAB_H = 0.45;
const MAX_DPR = 2;
const FOV = 55;

interface RacingLine { driven: Line2; ahead: Line2; segments: number }

function disposeObject(root: Group | Mesh | Line2) {
  root.traverse((o) => {
    const m = o as Mesh;
    m.geometry?.dispose();
    const mat = m.material as { dispose?: () => void } | undefined;
    mat?.dispose?.();
  });
}

export function createThreeRibbon(host: HTMLElement, events: RibbonEvents): RibbonRenderer {
  const colors = readColors(host);
  const gl = new WebGLRenderer({ antialias: true });
  gl.setClearColor(new Color(colors.bg), 1);
  const canvas = gl.domElement;
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  host.appendChild(canvas);
  const onLost = (e: Event) => { e.preventDefault(); events.onContextLost(); };
  const onRestored = () => events.onContextRestored();
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  let restoreTimer = 0;

  const scene = new ThreeScene();
  scene.fog = new Fog(new Color(colors.bg), 600, 3600);
  const camera = new PerspectiveCamera(FOV, 1, 0.5, 20000);
  scene.add(new HemisphereLight(0xdfe6f0, 0x20242b, 1.9));
  const sun = new DirectionalLight(0xffffff, 2.6);
  sun.position.set(-0.5, 1, 0.7);
  scene.add(sun, new AmbientLight(0xffffff, 0.15));

  /** Everything that follows the track's heights: the vertical exaggeration scales this group's y. */
  const world = new Group();
  scene.add(world);
  const cars = new Group();
  scene.add(cars);

  const lineMats: LineMaterial[] = [];
  const makeLineMat = (color: string, px: number) => {
    const m = new LineMaterial({ color: new Color(color).getHex(), linewidth: px, fog: true });
    lineMats.push(m);
    return m;
  };
  const addLine = (positions: Float32Array, mat: LineMaterial): Line2 => {
    const g = new LineGeometry();
    g.setPositions(positions);
    const l = new Line2(g, mat);
    l.frustumCulled = false;
    world.add(l);
    return l;
  };
  const setDrawn = (l: Line2, segments: number) => {
    (l.geometry as LineGeometry).instanceCount = Math.max(0, segments);
  };

  const controls = new OrbitControls(camera, canvas);
  controls.enabled = false;
  controls.enablePan = false;
  controls.minDistance = 4;
  controls.maxDistance = 4000;
  controls.maxPolarAngle = Math.PI / 2 - 0.03;
  let drawing = false;
  controls.addEventListener("change", () => { if (!drawing) events.onNeedsDraw(); });

  const rigs: Record<ViewMode, CameraRig> = { chase: new ChaseRig(), orbit: new OrbitRig(controls), top: new TopRig() };
  let mode: ViewMode = "chase";
  let entered: ViewMode | null = null;

  let viewport: Viewport = { w: 1, h: 1 };
  let exag = 1;
  let racing: RacingLine[] = [];
  let lapCar: Group | null = null, refCar: Group | null = null;
  let sceneMeshes: (Mesh | Line2)[] = [];
  let lastStats = { calls: 0, triangles: 0 };

  const clearScene = () => {
    for (const m of sceneMeshes) { world.remove(m); disposeObject(m); }
    sceneMeshes = [];
    for (const m of lineMats) m.dispose();
    racing = [];
    lineMats.length = 0;
    for (const c of [lapCar, refCar]) if (c) { cars.remove(c); disposeObject(c); }
    lapCar = refCar = null;
  };

  const makeCar = (dims: CarDims, color: string): Group => {
    const g = new Group();
    const mat = new MeshLambertMaterial({ color: new Color(color) });
    const body = new Mesh(new BoxGeometry(dims.width_m, CAR_BODY_H, dims.length_m), mat);
    body.position.y = CAR_BODY_Y + CAR_BODY_H / 2;
    // Cabin: narrower and shorter, set back from the nose (+z), so the heading shows.
    const cab = new Mesh(new BoxGeometry(dims.width_m * 0.75, CAB_H, dims.length_m * 0.4), mat);
    cab.position.set(0, CAR_BODY_Y + CAR_BODY_H + CAB_H / 2, -dims.length_m * 0.08);
    g.add(body, cab);
    g.rotation.order = "YXZ";
    return g;
  };

  const lineRgb = (xy: XY, heights: Float64Array, lift: number) => buildLinePositions(xy, heights, lift);

  const placeCar = (g: Group | null, p: CarPose) => {
    if (!g) return;
    const pos = toThree(p.east, p.north, p.height, exag);
    const e = carEuler(p);
    g.position.set(pos.x, pos.y, pos.z);
    g.rotation.set(e.x, e.y, 0);
  };

  const v3 = new Vector3();
  const frame: CameraFrame = { car: { x: 0, y: 0, z: 0 }, heading: 0, ahead: { x: 0, y: 0, z: 0 }, jumped: false };

  return {
    setScene({ scene: sc, heights }) {
      clearScene();
      const add = (m: Mesh | Line2) => { sceneMeshes.push(m); if (!m.parent) world.add(m); };
      // Track surface.
      const ribbon = buildRibbonMesh(sc.edges[0], sc.edges[1], heights);
      const rg = new BufferGeometry();
      rg.setAttribute("position", new BufferAttribute(ribbon.positions, 3));
      rg.setIndex(new BufferAttribute(ribbon.indices, 1));
      rg.computeVertexNormals();
      const surface = new Mesh(rg, new MeshLambertMaterial({
        color: new Color(mixSrgb(colors.line, colors.text, 0.15)), polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
      }));
      surface.frustumCulled = false;
      world.add(surface);
      sceneMeshes.push(surface);
      // Kerbs, merged into one mesh.
      const red = new Color(KERB_RED).toArray().slice(0, 3) as [number, number, number];
      const white = new Color(KERB_WHITE).toArray().slice(0, 3) as [number, number, number];
      const parts = sc.kerbs.map((k) => buildKerbMesh(k, heights, KERB_LIFT, red, white));
      if (parts.length > 0) {
        const vc = parts.reduce((a, p) => a + p.vertexCount, 0), ic = parts.reduce((a, p) => a + p.indices.length, 0);
        const pos = new Float32Array(vc * 3), col = new Float32Array(vc * 3), idx = new Uint32Array(ic);
        let vo = 0, io = 0;
        for (const p of parts) {
          pos.set(p.positions, vo * 3);
          col.set(p.colors, vo * 3);
          for (let i = 0; i < p.indices.length; i++) idx[io + i] = p.indices[i] + vo;
          vo += p.vertexCount;
          io += p.indices.length;
        }
        const kg = new BufferGeometry();
        kg.setAttribute("position", new BufferAttribute(pos, 3));
        kg.setAttribute("color", new BufferAttribute(col, 3));
        kg.setIndex(new BufferAttribute(idx, 1));
        kg.computeVertexNormals();
        const kerbs = new Mesh(kg, new MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
        kerbs.frustumCulled = false;
        world.add(kerbs);
        sceneMeshes.push(kerbs);
      }
      // Edge lines.
      const edgeMat = makeLineMat(mixSrgb(colors.line, colors.text, 0.5), EDGE_PX * 1.5);
      for (const e of sc.edges) add(addLine(lineRgb(e, heights, EDGE_LIFT), edgeMat));
      // Racing lines: dim for the part ahead, brighter over it up to the car.
      const mk = (xy: XY, color: string, px: number): RacingLine => {
        const driven = addLine(lineRgb(xy, heights, DRIVEN_LIFT), makeLineMat(mixSrgb(color, colors.bg, LINE_DIM), px));
        const ahead = addLine(lineRgb(xy, heights, AHEAD_LIFT), makeLineMat(mixSrgb(color, colors.bg, AHEAD_DIM), px / 2));
        sceneMeshes.push(driven, ahead);
        return { driven, ahead, segments: xy.x.length - 1 };
      };
      racing = [mk(sc.ref, colors.comparison, REF_PX), mk(sc.lap, colors.you, LAP_PX)];
      lapCar = makeCar(sc.lapDims, colors.you);
      refCar = makeCar(sc.refDims, colors.comparison);
      cars.add(lapCar, refCar);
      for (const m of lineMats) m.resolution.set(viewport.w, viewport.h);
      world.scale.y = exag;
    },
    setMode(m) {
      mode = m;
    },
    resize(v, dpr) {
      viewport = v;
      gl.setPixelRatio(Math.min(dpr, MAX_DPR));
      gl.setSize(Math.max(v.w, 1), Math.max(v.h, 1), false);
      camera.aspect = Math.max(v.w, 1) / Math.max(v.h, 1);
      camera.updateProjectionMatrix();
      for (const m of lineMats) m.resolution.set(Math.max(v.w, 1), Math.max(v.h, 1));
    },
    draw(f: RibbonFrame) {
      drawing = true;
      exag = f.exaggeration;
      world.scale.y = exag;
      placeCar(lapCar, f.lap);
      placeCar(refCar, f.ref);
      const car = toThree(f.lap.east, f.lap.north, f.lap.height, exag);
      const ahead = toThree(f.ahead.east, f.ahead.north, f.ahead.height, exag);
      frame.car = car;
      frame.ahead = ahead;
      frame.heading = f.lap.heading;
      frame.jumped = f.jumped;
      const rig = rigs[mode];
      if (entered !== mode) {
        if (entered) rigs[entered].leave?.();
        rig.enter(frame, camera);
        entered = mode;
      }
      rig.update(frame, camera);
      // Fog starts beyond the car and the near scenery, whatever the camera distance.
      const dist = rig.distance(camera);
      const fog = scene.fog as Fog;
      fog.near = dist * 1.5 + 400;
      fog.far = fog.near + 3000;
      const [ref, lap] = racing;
      if (ref) setDrawn(ref.driven, Math.min(Math.floor(f.refDist), ref.segments));
      if (lap) setDrawn(lap.driven, Math.min(Math.floor(f.lapDist), lap.segments));
      gl.render(scene, camera);
      lastStats = { calls: gl.info.render.calls, triangles: gl.info.render.triangles };
      drawing = false;
    },
    zoom(factor) {
      if (mode !== "orbit") rigs[mode].zoom(factor);
    },
    nudgeOrbit(rad) {
      if (mode !== "orbit") return;
      v3.copy(camera.position).sub(controls.target).applyAxisAngle(camera.up, rad);
      camera.position.copy(controls.target).add(v3);
    },
    project(east, north, height, out): ScreenPoint {
      v3.set(east, height * exag, -north).applyMatrix4(camera.matrixWorldInverse);
      out.visible = v3.z < -camera.near;
      v3.applyMatrix4(camera.projectionMatrix);
      out.x = (v3.x * 0.5 + 0.5) * viewport.w;
      out.y = (-v3.y * 0.5 + 0.5) * viewport.h;
      return out;
    },
    stats: () => lastStats,
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
      controls.dispose();
      clearScene();
      gl.dispose();
      try { gl.forceContextLoss(); } catch { /* context already lost */ }
      canvas.remove();
    },
  };
}
