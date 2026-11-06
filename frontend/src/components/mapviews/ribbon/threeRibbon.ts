import {
  AmbientLight, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, Color, DirectionalLight, DoubleSide, Fog, Group, HemisphereLight, Mesh,
  MeshBasicMaterial, MeshLambertMaterial, PMREMGenerator, PerspectiveCamera, Scene as ThreeScene, SphereGeometry, Texture, Vector3, WebGLRenderer,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { CarDims } from "../../../api/types";
import type { Viewport } from "../../../lib/camera";
import type { XY } from "../../../lib/geo";
import { AHEAD_DIM, EDGE_PX, KERB_RED, KERB_WHITE, LAP_PX, LINE_DIM, REF_PX, mixSrgb, readColors } from "../detailed/renderer";
import { CockpitRig, DEFAULT_FOV, OrbitFollowRig, OrbitRig, ChaseRig, TopRig, type CameraFrame, type CameraRig, type ViewMode } from "./cameraRigs";
import { createCockpitDash, type CockpitDash } from "./cockpitDash";
import { MIRROR_PX } from "./cockpitLayout";
import { createCockpitMirror, type CockpitMirror } from "./cockpitMirror";
import { readCockpitPalette } from "./cockpitPaint";
import { cockpitEye } from "./cockpit";
import { invalidateCarModel, loadCarModel, placeModel, type PlacedModel } from "./carModel";
import { carModelStore } from "./carModelStore";
import { visualForwardM } from "../detailed/renderer";
import { toThree } from "./coords";
import { buildKerbMesh, buildLinePositions, buildRibbonMesh, buildVergeMesh } from "./geometry";
import type { CarPose } from "./pose";
import { carEuler } from "./pose";
import { paneRects } from "./split";
import type { RibbonEvents, RibbonFrame, RibbonRenderer, ScreenPoint } from "./types";

/** Lifts (m, before the vertical exaggeration) that keep each layer clear of the one below it. */
const EDGE_LIFT = 0.02, KERB_LIFT = 0.03, AHEAD_LIFT = 0.05, DRIVEN_LIFT = 0.07;
const CAR_BODY_H = 0.6, CAR_BODY_Y = 0.15, CAB_H = 0.45;
const MAX_DPR = 2;
/** Fog in cockpit mode: the road fades into the haze within a couple of kilometres. */
const COCKPIT_FOG_NEAR = 150, COCKPIT_FOG_FAR = 2200;
const SKY_RADIUS = 10000;
/** The rear-view mirror renders the scene again from the eye, looking back; `?mirror=0` in the URL turns that off (the glass then shows a still picture). */
const LIVE_MIRROR = typeof location === "undefined" || !/[?&]mirror=0\b/.test(location.search);

/** Sky and grass colours from the theme tokens (--color-sky, ...), with the dark theme's values as fallback. */
function readScenery(el: Element) {
  const cs = getComputedStyle(el);
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    sky: get("--color-sky", "#2F4F78"), horizon: get("--color-sky-horizon", "#8EA3B8"),
    grass: get("--color-grass", "#3A5629"), grassAlt: get("--color-grass-alt", "#42612F"),
  };
}

/** A big sphere seen from inside: haze at and below the horizon, rising to the sky colour overhead. */
function makeSkyDome(sky: string, horizon: string): Mesh {
  const g = new SphereGeometry(SKY_RADIUS, 24, 16);
  const pos = g.getAttribute("position");
  const top = new Color(sky), low = new Color(horizon), c = new Color();
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const up = Math.max(pos.getY(i) / SKY_RADIUS, 0);
    c.copy(low).lerp(top, Math.pow(up, 0.55));
    c.toArray(colors, 3 * i);
  }
  g.setAttribute("color", new BufferAttribute(colors, 3));
  const m = new Mesh(g, new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false, depthWrite: false, depthTest: false }));
  m.renderOrder = -1;
  m.frustumCulled = false;
  return m;
}

/** One camera of the view with what belongs to it: its rigs, its cockpit (fixed to the camera) and the cockpit's mirror. The split view has two. */
interface Pane {
  camera: PerspectiveCamera;
  rigs: Record<ViewMode, CameraRig>;
  entered: ViewMode | null;
  frame: CameraFrame;
  dash: CockpitDash;
  mirror: CockpitMirror | null;
}

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
  gl.info.autoReset = false; // `draw` resets it once per frame, so the stats also count the cockpit mirror's pass
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
  const camera = new PerspectiveCamera(DEFAULT_FOV, 1, 0.5, 20000);
  const cameraFrame = (): CameraFrame => ({ car: { x: 0, y: 0, z: 0 }, heading: 0, ahead: { x: 0, y: 0, z: 0 }, jumped: false });
  scene.add(new HemisphereLight(0xdfe6f0, 0x20242b, 1.9));
  const sun = new DirectionalLight(0xffffff, 2.6);
  sun.position.set(-0.5, 1, 0.7);
  scene.add(sun, new AmbientLight(0xffffff, 0.15));

  /** Everything that follows the track's heights: the vertical exaggeration scales this group's y. */
  const world = new Group();
  scene.add(world);
  const cars = new Group();
  scene.add(cars);
  const scenery = readScenery(host);
  /** Grass verges and the sky: shown in the cockpit view only, where the camera is low enough to see past the road. */
  const verges = new Group();
  verges.visible = false;
  world.add(verges);
  const sky = makeSkyDome(scenery.sky, scenery.horizon);
  sky.visible = false;
  scene.add(sky);
  /** The cockpit (trim, bonnet, dash, mirror, displays, wheel): fixed to the camera, so the camera itself must be in the scene for it to render. */
  const palette = readCockpitPalette(host);
  const makeCockpit = (cam: PerspectiveCamera) => {
    const mirror = LIVE_MIRROR ? createCockpitMirror() : null;
    const dash = createCockpitDash(palette, mirror?.texture ?? null);
    cam.add(dash.root);
    scene.add(cam);
    return { mirror, dash };
  };
  const hazeColor = new Color(scenery.horizon), bgColor = new Color(colors.bg);

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

  /** The lap car's pane, always there. The reference car's pane is made on first use of the split view. */
  const lapPane: Pane = {
    camera, rigs: { chase: new ChaseRig(), cockpit: new CockpitRig(), orbit: new OrbitRig(controls), top: new TopRig() },
    entered: null, frame: cameraFrame(), ...makeCockpit(camera),
  };
  let refPane: Pane | null = null;
  const ensureRefPane = (): Pane => {
    if (refPane) return refPane;
    const cam = new PerspectiveCamera(DEFAULT_FOV, 1, 0.5, 20000);
    refPane = {
      camera: cam, rigs: { chase: new ChaseRig(), cockpit: new CockpitRig(), orbit: new OrbitFollowRig(camera, controls.target), top: new TopRig() },
      entered: null, frame: cameraFrame(), ...makeCockpit(cam),
    };
    // Start at the zoom the user already chose on the lap pane.
    (refPane.rigs.chase as ChaseRig).zoomK = (lapPane.rigs.chase as ChaseRig).zoomK;
    (refPane.rigs.top as TopRig).h = (lapPane.rigs.top as TopRig).h;
    return refPane;
  };
  let mode: ViewMode = "chase";
  /** True while the reference pane is drawn (the last frame had `refPane`). */
  let splitting = false;

  let viewport: Viewport = { w: 1, h: 1 };
  let exag = 1;
  let racing: RacingLine[] = [];
  let lapCar: Group | null = null, refCar: Group | null = null;
  /** Bumped on every setScene and on destroy: a model that finishes loading for an older scene is ignored. */
  let sceneToken = 0;
  /** A small generated environment (no HDR download) for the optional models' PBR materials; made on first use. */
  let envTexture: Texture | null = null;
  const environment = (): Texture => {
    if (!envTexture) {
      const pmrem = new PMREMGenerator(gl);
      envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    }
    return envTexture;
  };
  let lapForward = 0, refForward = 0; // each car's visual centre ahead of the recorded point (m); the cockpit eye is measured from the visual centre
  let sceneMeshes: (Mesh | Line2)[] = [];
  let lastStats = { calls: 0, triangles: 0 };

  const clearScene = () => {
    for (const m of sceneMeshes) { world.remove(m); disposeObject(m); }
    sceneMeshes = [];
    for (const m of lineMats) m.dispose();
    racing = [];
    lineMats.length = 0;
    for (const c of [lapCar, refCar]) if (c) { detachModel(c); cars.remove(c); disposeObject(c); }
    lapCar = refCar = null;
    slots = [];
    for (const v of [...verges.children]) { verges.remove(v); disposeObject(v as Mesh); }
  };

  /** The shared model parts must outlive a car (other cars and later scenes reuse them): take the model out before disposing the car's own box. */
  const detachModel = (car: Group) => {
    const placed = car.userData.placed as PlacedModel | undefined;
    if (!placed) return;
    car.remove(placed.group);
    placed.ownMaterial?.dispose();
    car.userData.placed = undefined;
  };

  /** The cars of the current scene, to re-fit when a car_id's stored model changes. */
  let slots: { car: Group; carId: string; dims: CarDims; ghost?: string }[] = [];
  let loadSeq = 0;

  /** Swaps a car's box for the optional 3D model of `carId` when one exists (#102); keeps the box otherwise. */
  const swapInModel = (car: Group, carId: string, dims: CarDims, ghost?: string) => {
    const token = sceneToken;
    const seq = (car.userData.seq = ++loadSeq);
    void loadCarModel(carId).then((model) => {
      if (!model || token !== sceneToken || car.userData.seq !== seq || car.userData.placed) return;
      const placed = placeModel(model, dims, environment(), ghost);
      car.userData.placed = placed;
      for (const o of car.userData.box as Mesh[]) o.visible = false;
      car.add(placed.group);
      events.onNeedsDraw();
    });
  };

  /** The user added, changed or removed the model of `carId`: put the box back on its cars and load again. */
  const unsubscribeModels = carModelStore().subscribe((carId) => {
    const hit = slots.filter((s) => s.carId === carId);
    if (!hit.length) return;
    for (const s of hit) {
      detachModel(s.car);
      for (const o of s.car.userData.box as Mesh[]) o.visible = true;
      s.car.userData.seq = ++loadSeq;
    }
    invalidateCarModel(carId);
    for (const s of hit) swapInModel(s.car, s.carId, s.dims, s.ghost);
    events.onNeedsDraw();
  });

  const makeCar = (dims: CarDims, color: string): Group => {
    const g = new Group();
    const mat = new MeshLambertMaterial({ color: new Color(color) });
    const body = new Mesh(new BoxGeometry(dims.width_m, CAR_BODY_H, dims.length_m), mat);
    // The recorded point is the physics point; the box is centred on the visual centre, ahead of it (+z is the nose).
    const shift = visualForwardM(dims);
    body.position.set(0, CAR_BODY_Y + CAR_BODY_H / 2, shift);
    // Cabin: narrower and shorter, set back from the nose (+z), so the heading shows.
    const cab = new Mesh(new BoxGeometry(dims.width_m * 0.75, CAB_H, dims.length_m * 0.4), mat);
    cab.position.set(0, CAR_BODY_Y + CAR_BODY_H + CAB_H / 2, shift - dims.length_m * 0.08);
    g.add(body, cab);
    g.userData.box = [body, cab];
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
  const toRgb = (hex: string) => new Color(hex).toArray().slice(0, 3) as [number, number, number];

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
      // Grass beside the road (cockpit view): one strip per side, following the road heights.
      const vergeMat = new MeshBasicMaterial({
        vertexColors: true, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 3, polygonOffsetUnits: 3,
      });
      for (const e of sc.edges) {
        const v = buildVergeMesh(e, sc.centre, heights, toRgb(scenery.grass), toRgb(scenery.grassAlt), toRgb(scenery.horizon));
        const vg = new BufferGeometry();
        vg.setAttribute("position", new BufferAttribute(v.positions, 3));
        vg.setAttribute("color", new BufferAttribute(v.colors, 3));
        vg.setIndex(new BufferAttribute(v.indices, 1));
        const vm = new Mesh(vg, vergeMat);
        vm.frustumCulled = false;
        verges.add(vm);
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
      lapForward = visualForwardM(sc.lapDims);
      refForward = visualForwardM(sc.refDims);
      lapCar = makeCar(sc.lapDims, colors.you);
      refCar = makeCar(sc.refDims, colors.comparison);
      cars.add(lapCar, refCar);
      sceneToken++;
      slots = [
        { car: lapCar, carId: sc.lapCarId, dims: sc.lapDims },
        { car: refCar, carId: sc.refCarId, dims: sc.refDims, ghost: colors.comparison },
      ];
      for (const s of slots) swapInModel(s.car, s.carId, s.dims, s.ghost);
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
    },
    draw(f: RibbonFrame) {
      drawing = true;
      exag = f.exaggeration;
      world.scale.y = exag;
      placeCar(lapCar, f.lap);
      placeCar(refCar, f.ref);
      const split = f.refPane;
      const ref = split ? ensureRefPane() : null;
      if (!split && splitting && refPane) {
        // Leaving the split view: the second camera and its cockpit must not stay in the scene's picture, and re-enter its rig next time.
        refPane.dash.root.visible = false;
        if (refPane.entered) refPane.rigs[refPane.entered].leave?.();
        refPane.entered = null;
      }
      splitting = !!split;
      const cockpit = mode === "cockpit";
      // Cockpit scenery: grass, sky and haze (both panes share them; they are the same mode).
      verges.visible = cockpit;
      sky.visible = cockpit;
      (scene.fog as Fog).color.copy(cockpit ? hazeColor : bgColor);

      const place = (pane: Pane, pose: CarPose, aheadPt: { east: number; north: number; height: number }, att: { heading: number; dive: number; roll: number }, forward: number, jumped: boolean) => {
        const fr = pane.frame;
        fr.car = toThree(pose.east, pose.north, pose.height, exag);
        fr.ahead = toThree(aheadPt.east, aheadPt.north, aheadPt.height, exag);
        fr.heading = pose.heading;
        fr.jumped = jumped;
        fr.eye = cockpit ? cockpitEye(fr.car, att.heading, pose.pitch + att.dive, att.roll, forward) : undefined;
        const rig = pane.rigs[mode];
        if (pane.entered !== mode) {
          if (pane.entered) pane.rigs[pane.entered].leave?.();
          rig.enter(fr, pane.camera);
          pane.entered = mode;
        }
        rig.update(fr, pane.camera);
      };
      // The lap pane's camera first: the reference pane's orbit follows its offset.
      place(lapPane, f.lap, f.ahead, f.lapAtt, lapForward, f.jumped);
      if (ref && split) place(ref, f.ref, split.ahead, split.att, refForward, f.jumped || split.jumped);

      // Fog starts beyond the car and the near scenery, whatever the camera distance.
      const dist = Math.max(lapPane.rigs[mode].distance(lapPane.camera), ref && split ? ref.rigs[mode].distance(ref.camera) : 0);
      const fog = scene.fog as Fog;
      fog.near = cockpit ? COCKPIT_FOG_NEAR : dist * 1.5 + 400;
      fog.far = cockpit ? COCKPIT_FOG_FAR : fog.near + 3000;
      const [refLine, lapLine] = racing;
      if (refLine) setDrawn(refLine.driven, Math.min(Math.floor(f.refDist), refLine.segments));
      if (lapLine) setDrawn(lapLine.driven, Math.min(Math.floor(f.lapDist), lapLine.segments));

      // One pass per pane into its part of the canvas; the stats count all passes (and the mirrors').
      gl.info.reset();
      const rects = paneRects(viewport, !!split);
      gl.setScissorTest(rects.length > 1);
      const panes = ref && split ? [lapPane, ref] : [lapPane];
      panes.forEach((pane, i) => {
        const r = rects[i];
        const w = Math.max(r.w, 1), h = Math.max(r.h, 1);
        const setLines = (lw: number, lh: number) => { for (const m of lineMats) m.resolution.set(lw, lh); };
        pane.camera.aspect = w / h;
        pane.camera.updateProjectionMatrix();
        // Each pane draws only its own cockpit; in the cockpit view the pane's own car is the camera (hide it) and the other car stays visible as the ghost.
        panes.forEach((q) => { q.dash.root.visible = q === pane && cockpit; });
        if (lapCar) lapCar.visible = !(cockpit && i === 0);
        if (refCar) refCar.visible = !(cockpit && i === 1);
        if (cockpit) {
          pane.dash.update(i === 0 ? f.dash : split!.dash, i === 0 ? f.limits : split!.limits);
          sky.position.copy(pane.camera.position);
        }
        gl.setViewport(r.x, viewport.h - r.y - r.h, r.w, r.h);
        gl.setScissor(r.x, viewport.h - r.y - r.h, r.w, r.h);
        setLines(w, h);
        // The mirror's picture first (its own pass, at most every other frame), then the pane's main pass.
        if (cockpit && pane.mirror) {
          pane.mirror.render(gl, scene, pane.camera, pane.dash.root, performance.now(), f.jumped || (i === 1 && split!.jumped), () => setLines(MIRROR_PX[0], MIRROR_PX[1]), () => setLines(w, h));
        }
        gl.render(scene, pane.camera);
      });
      lastStats = { calls: gl.info.render.calls, triangles: gl.info.render.triangles };
      drawing = false;
    },
    zoom(factor) {
      if (mode === "orbit") return;
      lapPane.rigs[mode].zoom(factor);
      refPane?.rigs[mode].zoom(factor);
    },
    nudgeOrbit(rad) {
      if (mode !== "orbit") return;
      v3.copy(camera.position).sub(controls.target).applyAxisAngle(camera.up, rad);
      camera.position.copy(controls.target).add(v3);
    },
    project(east, north, height, out): ScreenPoint {
      // The badges mark the reference line, so in the split view they are drawn in the reference pane (the right half).
      const pane = splitting && refPane ? refPane : lapPane;
      const r = paneRects(viewport, splitting)[splitting ? 1 : 0];
      const cam = pane.camera;
      v3.set(east, height * exag, -north).applyMatrix4(cam.matrixWorldInverse);
      out.visible = v3.z < -cam.near;
      v3.applyMatrix4(cam.projectionMatrix);
      out.x = r.x + (v3.x * 0.5 + 0.5) * r.w;
      out.y = r.y + (-v3.y * 0.5 + 0.5) * r.h;
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
      sceneToken++;
      unsubscribeModels();
      window.clearTimeout(restoreTimer);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      controls.dispose();
      clearScene();
      disposeObject(sky);
      for (const pane of [lapPane, refPane]) {
        if (!pane) continue;
        pane.camera.remove(pane.dash.root);
        pane.dash.dispose();
        pane.mirror?.dispose();
      }
      envTexture?.dispose();
      gl.dispose();
      try { gl.forceContextLoss(); } catch { /* context already lost */ }
      canvas.remove();
    },
  };
}
