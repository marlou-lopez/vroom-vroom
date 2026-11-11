/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Recording } from "../../../api/mock/recording";
import { createMockApi } from "../../../api/mock/mockApi";
import type { ElevationTrack } from "../../../lib/elevation";
import { buildScene } from "../detailed/scene";
import { buildKerbMesh, buildRibbonMesh } from "./geometry";
import { heightAt, roadHeights } from "./heights";
import { carPose } from "./pose";

const read = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));
const REC = read("../../../../public/mock/spa-2026-11-03.json") as Recording;
const CAP = read("../../../../public/mock/spa-elevation-2026-11-05.json") as ElevationTrack;

async function spa(lapNo: number, refNo: number) {
  const api = createMockApi({ coachDelayMs: 0, loadSpa: async () => REC, loadElevation: async () => CAP });
  const s = (await api.sessions()).find((x) => x.started_at.startsWith("2026-11-03"))!;
  const laps = await api.sessionLaps(s.session_id);
  const id = (no: number) => laps.find((l) => l.lap_no === no)!.lap_id;
  return { cmp: await api.compare(id(lapNo), id(refNo)), geometry: await api.trackGeometry(s.track_id) };
}

describe("3D ribbon on Spa lap 4 vs 3", async () => {
  const { cmp, geometry } = await spa(4, 3);
  const scene = buildScene(cmp, { source: "lateral", gpsHalf: 4, edges: "telemetry" });
  const n = scene.centre.x.length;
  const h = roadHeights(geometry.elevation_m, n)!;

  it("has road heights for the whole lap", () => {
    expect(h).not.toBeNull();
    expect(h.length).toBe(n);
    expect(Array.from(h).every(Number.isFinite)).toBe(true);
  });

  it("the ribbon vertices carry the heights on the climb out of Eau Rouge (about -1 m at 1005 m, 25.4 m at 1305 m)", () => {
    const mesh = buildRibbonMesh(scene.edges[0], scene.edges[1], h);
    expect(mesh.vertexCount).toBe(2 * n);
    const y = (i: number) => mesh.positions[3 * (2 * i) + 1];
    expect(y(1005)).toBeGreaterThan(-1.5);
    expect(y(1005)).toBeLessThan(-0.5);
    expect(y(1305)).toBeGreaterThan(24.9);
    expect(y(1305)).toBeLessThan(25.9);
    // Both edges of a point share its height.
    expect(mesh.positions[3 * (2 * 1305 + 1) + 1]).toBe(y(1305));
    // The whole lap spans about 100 m of height.
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { lo = Math.min(lo, y(i)); hi = Math.max(hi, y(i)); }
    expect(hi - lo).toBeGreaterThan(95);
    expect(hi - lo).toBeLessThan(110);
  });

  it("the lap car is nose-up on the Eau Rouge / Raidillon climb and nose-down on the descent before it", () => {
    const heading = (d: number) => {
      const a = Math.max(d - 10, 0), b = d + 10;
      return Math.atan2(scene.lap.y[b] - scene.lap.y[a], scene.lap.x[b] - scene.lap.x[a]);
    };
    // The steepest part of the climb is about 1060 m in (measured pitch 0.16 rad, about 16 %).
    const climb = carPose(scene.lap, h, 1050, heading(1050));
    expect(climb.pitch).toBeGreaterThan(0.12);
    expect(climb.pitch).toBeLessThan(0.2);
    // Past the top it eases off but stays nose-up for a while (Raidillon top at 1305 m).
    expect(carPose(scene.lap, h, 1250, heading(1250)).pitch).toBeGreaterThan(0.02);
    // The long descent from the first straight (measured pitch about -0.065 rad).
    const drop = carPose(scene.lap, h, 500, heading(500));
    expect(drop.pitch).toBeLessThan(-0.04);
    // Exaggeration steepens the pitch to match the stretched surface.
    expect(carPose(scene.lap, h, 1050, heading(1050), 3).pitch).toBeGreaterThan(climb.pitch);
    expect(heightAt(h, 1305)).toBeGreaterThan(heightAt(h, 1005) + 20);
  });

  it("kerbs lie at the heights of their stretch of road", () => {
    expect(scene.kerbs.length).toBeGreaterThan(0);
    const k = scene.kerbs[0];
    const m = buildKerbMesh(k, h, 0, [1, 0, 0], [1, 1, 1]);
    expect(m.positions[1]).toBeCloseTo(h[k.start], 4);
  });
});

describe("a track without elevation (Monza-like, no capture)", async () => {
  const api = createMockApi({ coachDelayMs: 0, loadSpa: async () => REC });
  const s = (await api.sessions()).find((x) => x.started_at.startsWith("2026-11-03"))!;
  const geometry = await api.trackGeometry(s.track_id);

  it("has no road heights, so the view draws flat", () => {
    expect(geometry.elevation_m).toBeNull();
    expect(roadHeights(geometry.elevation_m, geometry.centre.lat.length)).toBeNull();
  });
});
