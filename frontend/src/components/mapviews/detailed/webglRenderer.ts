import {
  BufferGeometry, CircleGeometry, Color, Float32BufferAttribute, Mesh, MeshBasicMaterial, DoubleSide, OrthographicCamera, RingGeometry, Scene as ThreeScene, WebGLRenderer,
} from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { XY } from "../../../lib/geo";
import { CAR_R_PX, LINE_DIM, CASING_PX, CHEVRON_BELOW_M, CHEVRON_LEN_PX, CHEVRON_WID_PX, EDGE_PX, LAP_PX, REF_PX, readColors, type Frame, type Renderer } from "./renderer";
import type { Scene } from "./scene";

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

export function createWebglRenderer(host: HTMLElement): Renderer {
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

  const scene = new ThreeScene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  camera.position.z = 10;

  const lineMats: LineMaterial[] = [];
  const makeMat = (color: string, px: number) => {
    const m = new LineMaterial({ color: new Color(color).getHex(), linewidth: px, worldUnits: false });
    lineMats.push(m);
    return m;
  };
  const edgeMat = makeMat(colors.line, EDGE_PX);
  const casingMat = makeMat(colors.bg, CASING_PX);
  // Lines are dimmed toward the background so the cars (full colour) read as distinct from their own line.
  const dim = (c: string) => "#" + new Color(c).lerp(new Color(colors.bg), LINE_DIM).getHexString();
  const refMat = makeMat(dim(colors.comparison), REF_PX);
  const lapMat = makeMat(dim(colors.you), LAP_PX);
  let lines: Line2[] = [];
  let lineGeoms: LineGeometry[] = [];

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
      };
      add(s.edges[0], edgeMat, 1);
      add(s.edges[1], edgeMat, 1);
      add(s.ref, casingMat, 2);
      add(s.ref, refMat, 3);
      add(s.lap, lapMat, 4);
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
      for (const m of carMeshes) m.scale.set(unit, unit, 1);
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
      gl.render(scene, camera);
    },
    destroy() {
      clearLines();
      for (const m of lineMats) m.dispose();
      for (const m of carMeshes) { m.geometry.dispose(); (m.material as MeshBasicMaterial).dispose(); }
      gl.dispose();
      gl.forceContextLoss();
      canvas.remove();
    },
  };
}
