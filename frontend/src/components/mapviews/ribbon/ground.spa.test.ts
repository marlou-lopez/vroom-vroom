/// <reference types="node" />
// The ground mesh under the real Spa road (vroom-ueg.9): no picture needed, only the shape.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createMockApi } from "../../../api/mock/mockApi";
import { buildScene } from "../detailed/scene";
import { buildTerrain, sceneFrame, type GroundTile } from "./ground";
import { roadHeights } from "./heights";

const read = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../public/mock/${p}`, import.meta.url)), "utf8"));

it("stays below the Spa road and close to it at both edges", async () => {
  const api = createMockApi({
    coachDelayMs: 0, loadSpa: async () => read("spa-2026-11-03.json"), loadElevation: async () => read("spa-elevation-2026-11-05.json"),
    loadSurvey: async () => read("spa-survey-2026-11-06.json"),
  });
  const s = (await api.sessions()).find((x) => x.started_at.startsWith("2026-11-03"))!;
  const laps = await api.sessionLaps(s.session_id);
  const id = (no: number) => laps.find((l) => l.lap_no === no)!.lap_id;
  const geometry = await api.trackGeometry(s.track_id);
  const scene = buildScene(await api.compare(id(4), id(3)), { source: "lateral", gpsHalf: 4, edges: "telemetry", survey: geometry.survey });
  const n = scene.centre.x.length;
  const heights = roadHeights(geometry.elevation_m, n)!;
  const f = sceneFrame(scene.origin);
  const T = 128;
  const keys = new Set<string>();
  for (let i = 0; i < n; i++) {
    const w = f.toWorld(scene.centre.x[i], scene.centre.y[i]);
    for (const dx of [-20, 20]) for (const dz of [-20, 20]) keys.add(`${Math.floor((w.x + dx) / T)},${Math.floor((w.z + dz) / T)}`);
  }
  const tiles: GroundTile[] = [...keys].map((k) => { const [a, b] = k.split(",").map(Number); return { file: "t.jpg", x: a * T, z: b * T, px: 512 }; });
  const terrain = buildTerrain(scene, heights, tiles, T, 150);
  const gaps: number[] = [];
  let poke = 0, worst = 0;
  for (let i = 0; i < n; i++) {
    for (const e of scene.edges) {
      for (const k of [0, 0.5, 1]) {
        const w = f.toWorld(scene.centre.x[i] + (e.x[i] - scene.centre.x[i]) * k, scene.centre.y[i] + (e.y[i] - scene.centre.y[i]) * k);
        const gap = heights[i] - terrain.at(w.x, w.z);
        if (k === 1) gaps.push(gap);
        if (gap < 0) poke++;
        worst = Math.min(worst, gap);
      }
    }
  }
  gaps.sort((a, b) => a - b);
  const q = (p: number) => gaps[Math.floor(p * (gaps.length - 1))];
  expect(worst).toBeGreaterThan(-0.05);
  expect(q(0.5)).toBeLessThan(0.1);
  expect(q(1)).toBeLessThan(0.25);
}, 30_000);
