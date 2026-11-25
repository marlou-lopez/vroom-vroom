// Track edges and kerbs from open aerial imagery (vroom-ueg.8, experimental), on a lap's 1 m grid.
import type { AerialEdges, SurveyKerb, TrackSurvey } from "../api/types";
import { worldToLatLon } from "./elevation";
import { SURVEY_MATCH_M, polylineMatcher } from "./trackSurvey";

/** The shape of public/mock/<track>-aerial-*.json (written by tools/aerial-edges). Positions are world x/z; side: 0 = left, 1 = right. */
export interface AerialFile {
  source: string;
  track: string;
  attribution: string;
  licence: string;
  licence_url?: string;
  edges: [x: number, z: number, side: 0 | 1][];
  kerbs: { side: "left" | "right"; start: [x: number, z: number]; end: [x: number, z: number]; width_m: number }[];
}

/** The imagery's points near the lap as lat/lon and its kerbs as grid runs. A kerb is inside out (end before start) only across the finish line and is dropped. */
export function mapAerial(file: AerialFile, lat: ArrayLike<number>, lon: ArrayLike<number>): AerialEdges {
  const match = polylineMatcher(lat, lon, SURVEY_MATCH_M);
  const edge_points: [number, number][] = [];
  for (const [x, z] of file.edges) {
    if (match(x, z) === null) continue;
    const p = worldToLatLon(x, z);
    edge_points.push([Math.round(p.lat * 1e7) / 1e7, Math.round(p.lon * 1e7) / 1e7]);
  }
  const kerbs: SurveyKerb[] = [];
  for (const k of file.kerbs) {
    const a = match(...k.start), b = match(...k.end);
    if (a !== null && b !== null && a < b) kerbs.push({ side: k.side, start_m: a, end_m: b, kind: "flat", width_m: k.width_m });
  }
  return { edge_points, kerbs, attribution: file.attribution, licence_url: file.licence_url || null };
}

/** The imagery as the survey the scene draws: its edge points and kerbs, with the real survey's widths as the fallback where no line was seen. */
export function aerialAsSurvey(aerial: AerialEdges, survey: TrackSurvey | null | undefined): TrackSurvey {
  return {
    left_m: survey?.left_m ?? [], right_m: survey?.right_m ?? [], bank_deg: survey?.bank_deg ?? [],
    kerbs: aerial.kerbs, edge_points: aerial.edge_points, kerb_outer_points: [],
  };
}
