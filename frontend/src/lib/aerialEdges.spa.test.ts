// The committed Spa aerial edges against the committed survey (vroom-ueg.8): the app's own path from file to half-widths.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { aerialAsSurvey, mapAerial, type AerialFile } from "./aerialEdges";
import { worldToLatLon } from "./elevation";
import { mapSurvey, type SurveyFile } from "./trackSurvey";

const read = (f: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../public/mock/${f}`, import.meta.url)), "utf8"));
const file = read("spa-aerial-2023.json") as AerialFile;
const spa = read("spa-2026-11-03.json") as { laps: { lap_no: number; lat: number[]; lon: number[] }[] };
const lap = spa.laps.find((l) => l.lap_no === 4)!;
const aerial = mapAerial(file, lap.lat, lap.lon);

describe("Spa edges and kerbs from aerial imagery", () => {
  it("maps nearly every point and kerb to the lap, with the credit line", () => {
    expect(aerial.edge_points.length / file.edges.length).toBeGreaterThan(0.95);
    expect(aerial.kerbs.length).toBeGreaterThan(40);
    expect(aerial.attribution).toMatch(/SPW.*CC BY 4\.0/);
    for (const k of aerial.kerbs) expect(k.end_m).toBeGreaterThan(k.start_m);
  });

  it("lies on the survey's edge contacts: median distance under 0.3 m", () => {
    const survey = mapSurvey(read("spa-survey-2026-11-06.json") as SurveyFile, lap.lat, lap.lon);
    const metres = 111194.93; // per degree of latitude; longitude scaled below as the recording does (cos 60)
    const grid = new Map<string, [number, number][]>();
    const key = (x: number, y: number) => `${Math.floor(x / 3)},${Math.floor(y / 3)}`;
    const pts = aerial.edge_points.map(([la, lo]) => [lo * metres * 0.5, la * metres] as [number, number]);
    for (const p of pts) (grid.get(key(...p)) ?? grid.set(key(...p), []).get(key(...p))!).push(p);
    const d: number[] = [];
    for (const [la, lo] of survey.edge_points) {
      const x = lo * metres * 0.5, y = la * metres;
      const near: [number, number][] = [];
      for (const dx of [-3, 0, 3]) for (const dy of [-3, 0, 3]) near.push(...(grid.get(key(x + dx, y + dy)) ?? []));
      if (near.length < 2) continue;
      near.sort((a, b) => Math.hypot(a[0] - x, a[1] - y) - Math.hypot(b[0] - x, b[1] - y));
      const [p, q] = near; // distance to the line through the two nearest points
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (l > 0.5 && l < 2.5) d.push(Math.abs((q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0])) / l);
    }
    d.sort((a, b) => a - b);
    expect(d.length).toBeGreaterThan(3000);
    expect(d[d.length >> 1]).toBeLessThan(0.3);
  });

  it("drops kerbs that run backwards or lie far from the lap", () => {
    const at = (i: number): [number, number] => { const M = 111194.93; return [lap.lon[i] * M * 0.5, (lap.lat[i] - 60) * M]; };
    expect(worldToLatLon(...at(100)).lat).toBeCloseTo(lap.lat[100], 5);
    const k = (start: [number, number], end: [number, number]) => ({ side: "left" as const, start, end, width_m: 1 });
    const out = mapAerial({ ...file, edges: [], kerbs: [k(at(100), at(140)), k(at(140), at(100)), k([0, 99999], [10, 99999])] }, lap.lat, lap.lon);
    expect(out.kerbs).toHaveLength(1);
    expect(aerialAsSurvey(out, null)).toMatchObject({ left_m: [], kerbs: out.kerbs, kerb_outer_points: [] });
  });
});
