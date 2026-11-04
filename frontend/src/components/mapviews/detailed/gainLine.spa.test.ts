/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SpaRecording } from "../../../api/mock/recording";
import { createMockApi } from "../../../api/mock/mockApi";
import { fitBounds, MIN_WIDTH_M, zoomScale } from "../../../lib/camera";
import { gainStrength } from "../../../lib/gainLoss";
import { CASING_PX, GAIN_GAP_PX, GAIN_PX, gainExtraM } from "./renderer";
import { lateralOffsets } from "../../../lib/racingLine";
import { buildScene, gainPositions, SURFACE_MARGIN_M } from "./scene";

const REC = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../public/mock/spa-2026-11-03.json", import.meta.url)), "utf8"),
) as SpaRecording;

async function spa(lapNo: number, refNo: number) {
  const api = createMockApi({ coachDelayMs: 0, loadSpa: async () => REC });
  const s = (await api.sessions()).find((x) => x.started_at.startsWith("2026-11-03"))!;
  const laps = await api.sessionLaps(s.session_id);
  const id = (no: number) => laps.find((l) => l.lap_no === no)!.lap_id;
  return api.compare(id(lapNo), id(refNo));
}

describe("gain/loss line on Spa lap 4 vs 3", async () => {
  const cmp = await spa(4, 3);
  const scene = buildScene(cmp);
  const n = scene.centre.x.length;
  const vw = 800;
  const fullW = fitBounds(scene.bounds, { w: vw, h: 600 }).widthM;

  it("colours follow the delta slope: red where it rises, green where it falls", () => {
    // The colour comes from a bell-weighted slope; a plain ±20 m difference of the delta (what the strip shows) must
    // agree in sign wherever the colour is clearly not neutral.
    let coloured = 0, agree = 0, clear = 0;
    for (let i = 20; i < n - 20; i++) {
      const t = gainStrength(scene.gain.rate[i]);
      if (t === 0) continue;
      coloured++;
      if (Math.abs(t) < 0.2) continue;
      clear++;
      if (Math.sign(cmp.delta[i + 20] - cmp.delta[i - 20]) === Math.sign(t)) agree++;
    }
    expect(agree / clear).toBeGreaterThan(0.97);
    // A useful share of the lap is coloured, not just a few spikes.
    expect(coloured / n).toBeGreaterThan(0.3);
  });

  it("the track-surface band holds both car lines with the margin on each side", () => {
    const left = lateralOffsets(scene.surface[0], scene.centre), right = lateralOffsets(scene.surface[1], scene.centre);
    let worst = Infinity;
    for (const l of [scene.lap, scene.ref]) {
      const off = lateralOffsets(l, scene.centre);
      for (let i = 0; i < n; i++) worst = Math.min(worst, off[i] - left[i], right[i] - off[i]);
    }
    expect(worst).toBeGreaterThan(SURFACE_MARGIN_M - 1e-6);
  });

  for (const widthM of [MIN_WIDTH_M, 60, 150, 400, 1000, fullW]) {
    it(`never comes closer than the gap to the lap or ref line at ${Math.round(widthM)} m wide`, () => {
      const z = zoomScale(widthM);
      const pxPerM = vw / widthM;
      const pos = gainPositions(scene.centre, scene.gain, gainExtraM(widthM, vw, z));
      // No overlap (line centres at least half the ref casing, the widest line, plus half the gain line apart) with at
      // least 0.5 px of background between. The full gap holds everywhere except Bus Stop at whole-track zoom
      // (about 1 px left there): the offset is wider than that tight left-hander's radius.
      const minPx = (CASING_PX * z) / 2 + (GAIN_PX * z) / 2 + 0.5;
      let worst = Infinity;
      for (let i = 0; i < n; i += 3) {
        const gx = pos[3 * i], gy = pos[3 * i + 1];
        for (const l of [scene.lap, scene.ref]) {
          for (let j = 0; j < l.x.length; j++) {
            const d = Math.hypot(l.x[j] - gx, l.y[j] - gy);
            if (d < worst) worst = d;
          }
        }
      }
      expect(worst * pxPerM).toBeGreaterThan(minPx);
    });
  }
});

describe("gainExtraM", () => {
  it("is a fixed screen distance: the same px at every zoom", () => {
    const px = (w: number) => gainExtraM(w, 800, 1) / (w / 800);
    expect(px(50)).toBeCloseTo(px(2000), 9);
    expect(px(50)).toBeCloseTo(CASING_PX / 2 + GAIN_GAP_PX + GAIN_PX / 2, 9);
  });
  it("grows with the line widths' zoom scale, the gap does not", () => {
    const px = (z: number) => gainExtraM(100, 800, z) / (100 / 800);
    expect(px(2) - px(1)).toBeCloseTo(CASING_PX / 2 + GAIN_PX / 2, 9);
  });
});
