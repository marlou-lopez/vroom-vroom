import { worldToScreen } from "../../../lib/camera";
import type { XY } from "../../../lib/geo";
import { CAR_R_PX, EDGE_PX, LAP_PX, REF_PX, cameraMatrix, readColors, type Frame, type Renderer } from "./renderer";
import type { Scene } from "./scene";

function toPath(xy: XY): Path2D {
  const p = new Path2D();
  for (let i = 0; i < xy.x.length; i++) {
    if (i === 0) p.moveTo(xy.x[i], xy.y[i]); else p.lineTo(xy.x[i], xy.y[i]);
  }
  return p;
}

export function createCanvasRenderer(host: HTMLElement): Renderer {
  const colors = readColors(host);
  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  host.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;
  let paths: { edgeA: Path2D; edgeB: Path2D; ref: Path2D; lap: Path2D } | null = null;
  let dpr = 1;
  let lastW = -1, lastH = -1, lastDpr = -1;

  return {
    setScene(s: Scene) {
      paths = { edgeA: toPath(s.edges[0]), edgeB: toPath(s.edges[1]), ref: toPath(s.ref), lap: toPath(s.lap) };
    },
    resize(v, ratio) {
      if (v.w === lastW && v.h === lastH && ratio === lastDpr) return;
      lastW = v.w; lastH = v.h; lastDpr = ratio; dpr = ratio;
      canvas.width = Math.max(1, Math.round(v.w * ratio));
      canvas.height = Math.max(1, Math.round(v.h * ratio));
      canvas.style.width = `${v.w}px`;
      canvas.style.height = `${v.h}px`;
    },
    draw(f: Frame) {
      const v = f.viewport;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (paths) {
        const m = cameraMatrix(f.camera, v);
        const scale = v.w / f.camera.widthM;
        ctx.setTransform(dpr * m[0], dpr * m[1], dpr * m[2], dpr * m[3], dpr * m[4], dpr * m[5]);
        ctx.lineJoin = "round";
        ctx.lineWidth = EDGE_PX / scale;
        ctx.strokeStyle = colors.line;
        ctx.stroke(paths.edgeA);
        ctx.stroke(paths.edgeB);
        ctx.lineWidth = REF_PX / scale;
        ctx.strokeStyle = colors.comparison;
        ctx.stroke(paths.ref);
        ctx.lineWidth = LAP_PX / scale;
        ctx.strokeStyle = colors.you;
        ctx.stroke(paths.lap);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const r = worldToScreen(f.camera, v, f.refCar);
      ctx.beginPath();
      ctx.arc(r.x, r.y, CAR_R_PX, 0, Math.PI * 2);
      ctx.fillStyle = colors.bg;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = colors.comparison;
      ctx.stroke();
      const l = worldToScreen(f.camera, v, f.lapCar);
      ctx.beginPath();
      ctx.arc(l.x, l.y, CAR_R_PX, 0, Math.PI * 2);
      ctx.fillStyle = colors.you;
      ctx.fill();
    },
    destroy() { canvas.remove(); paths = null; },
  };
}
