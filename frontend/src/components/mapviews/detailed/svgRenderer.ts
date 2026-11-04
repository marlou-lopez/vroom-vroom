import { worldToScreen } from "../../../lib/camera";
import type { XY } from "../../../lib/geo";
import { CAR_R_PX, EDGE_PX, LAP_PX, REF_PX, cameraMatrix, readColors, type Frame, type Renderer } from "./renderer";
import type { Scene } from "./scene";

const NS = "http://www.w3.org/2000/svg";

function pathData(xy: XY): string {
  const parts: string[] = [];
  for (let i = 0; i < xy.x.length; i++) {
    parts.push(`${i === 0 ? "M" : "L"}${xy.x[i].toFixed(2)} ${xy.y[i].toFixed(2)}`);
  }
  return parts.join("");
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

export function createSvgRenderer(host: HTMLElement): Renderer {
  const colors = readColors(host);
  const svg = el("svg", { width: "100%", height: "100%" });
  svg.style.position = "absolute";
  svg.style.inset = "0";
  svg.style.display = "block";
  const g = document.createElementNS(NS, "g");
  const stroke = (color: string, px: number) =>
    ({ fill: "none", stroke: color, "stroke-width": String(px), "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke" });
  const edgeA = el("path", stroke(colors.line, EDGE_PX));
  const edgeB = el("path", stroke(colors.line, EDGE_PX));
  const refPath = el("path", stroke(colors.comparison, REF_PX));
  const lapPath = el("path", stroke(colors.you, LAP_PX));
  g.append(edgeA, edgeB, refPath, lapPath);
  const refCar = el("circle", { r: String(CAR_R_PX), fill: colors.bg, stroke: colors.comparison, "stroke-width": "1.5" });
  const lapCar = el("circle", { r: String(CAR_R_PX), fill: colors.you });
  svg.append(g, refCar, lapCar);
  host.appendChild(svg);

  let lastW = -1, lastH = -1;
  return {
    setScene(s: Scene) {
      edgeA.setAttribute("d", pathData(s.edges[0]));
      edgeB.setAttribute("d", pathData(s.edges[1]));
      refPath.setAttribute("d", pathData(s.ref));
      lapPath.setAttribute("d", pathData(s.lap));
    },
    resize(v) {
      if (v.w === lastW && v.h === lastH) return;
      lastW = v.w; lastH = v.h;
      svg.setAttribute("viewBox", `0 0 ${v.w} ${v.h}`);
    },
    draw(f: Frame) {
      const m = cameraMatrix(f.camera, f.viewport);
      g.setAttribute("transform", `matrix(${m[0]} ${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]})`);
      const r = worldToScreen(f.camera, f.viewport, f.refCar);
      const l = worldToScreen(f.camera, f.viewport, f.lapCar);
      refCar.setAttribute("cx", String(r.x)); refCar.setAttribute("cy", String(r.y));
      lapCar.setAttribute("cx", String(l.x)); lapCar.setAttribute("cy", String(l.y));
    },
    destroy() { svg.remove(); },
  };
}
