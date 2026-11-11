/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { roadHeights } from "../components/mapviews/ribbon/heights";
import type { TrackSurvey } from "../api/types";
import { estimateAttitude } from "./carAttitude";
import { worldToLatLon } from "./elevation";
import { lineFromGps } from "./racingLine";
import { mapSurvey, type SurveyFile } from "./trackSurvey";

// The Spa flying lap of 2026-11-05 with the exact orientation from the shared-memory capture, written by
// tools/lmu-logger/attitude_check.py --fixture. Quantised: cm, milli-g, 0.01 degree.
interface Fixture {
  east_cm: number[]; north_cm: number[]; height_cm: number[]; g_lat_mg: number[]; g_long_mg: number[];
  yaw_cdeg: number[]; pitch_cdeg: number[]; roll_cdeg: number[];
}
const FX = JSON.parse(gunzipSync(readFileSync(fileURLToPath(new URL("./fixtures/spa-attitude-2026-11-05.json.gz", import.meta.url)))).toString()) as Fixture;
const n = FX.east_cm.length;
const cm = (v: number[]) => Float64Array.from(v, (x) => x / 100);
const line = lineFromGps({ x: cm(FX.east_cm), y: cm(FX.north_cm) }, 4);
const heights = roadHeights(Array.from(cm(FX.height_cm)), n)!;
const att = estimateAttitude({ line, heights, gLat: FX.g_lat_mg.map((v) => v / 1000), gLong: FX.g_long_mg.map((v) => v / 1000) });

// The road bank from the committed survey (all four captures, so it includes the session being checked; the independent
// check, bank from the 11-06 captures only, is in attitude_check.py and docs/track-views/cockpit-view.md).
const SURVEY = JSON.parse(readFileSync(fileURLToPath(new URL("../../public/mock/spa-survey-2026-11-06.json", import.meta.url)), "utf8")) as SurveyFile;
const ll = Array.from({ length: n }, (_, i) => worldToLatLon(FX.east_cm[i] / 100, FX.north_cm[i] / 100));
const surveyed: TrackSurvey = mapSurvey(SURVEY, ll.map((p) => p.lat), ll.map((p) => p.lon));
const DEG = Math.PI / 180;
const pct = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(p * v.length))];
const wrap = (a: number) => ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
const errs = (f: (i: number) => number) => {
  const e = Array.from({ length: n }, (_, i) => Math.abs(f(i)) / DEG);
  return { median: pct(e, 0.5), p90: pct(e, 0.9), max: Math.max(...e) };
};

describe("attitude estimate against the capture's exact orientation (Spa flying lap)", () => {
  it("has the whole lap", () => {
    expect(n).toBeGreaterThan(6900);
    expect(att.heading.length).toBe(n);
  });

  it("pitch (road slope + dive) is within 0.1 deg at the median and 0.25 deg at the 90th percentile", () => {
    const e = errs((i) => FX.pitch_cdeg[i] * 0.01 * DEG - att.pitch[i]);
    expect(e.median).toBeLessThan(0.1);
    expect(e.p90).toBeLessThan(0.25);
    expect(e.max).toBeLessThan(1);
  });

  it("roll without the road bank is body roll only: 1.8 deg at the median, 3.1 at the 90th percentile", () => {
    const e = errs((i) => FX.roll_cdeg[i] * 0.01 * DEG - att.roll[i]);
    expect(e.median).toBeLessThan(1.8);
    expect(e.p90).toBeLessThan(3.1);
  });

  it("with the surveyed road bank roll is within 0.35 deg at the median and 1.1 deg at the 90th percentile", () => {
    expect(surveyed.bank_deg.filter((v) => v !== null).length / n).toBeGreaterThan(0.99);
    const withBank = estimateAttitude({
      line, heights, gLat: FX.g_lat_mg.map((v) => v / 1000), gLong: FX.g_long_mg.map((v) => v / 1000),
      bank: surveyed.bank_deg.map((d) => (d === null ? null : d * DEG)),
    });
    const e = errs((i) => FX.roll_cdeg[i] * 0.01 * DEG - withBank.roll[i]);
    expect(e.median).toBeLessThan(0.35);
    expect(e.p90).toBeLessThan(1.1);
    expect(e.max).toBeLessThan(5.5);
  });

  it("the direction of travel is within 0.5 deg of the car's yaw at the median and 1.6 deg at the 90th percentile (the slip angle)", () => {
    const e = errs((i) => wrap(FX.yaw_cdeg[i] * 0.01 * DEG - att.heading[i]));
    expect(e.median).toBeLessThan(0.5);
    expect(e.p90).toBeLessThan(1.6);
    expect(e.max).toBeLessThan(6);
  });
});
