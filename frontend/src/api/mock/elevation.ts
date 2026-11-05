// The Spa elevation capture served at /mock/spa-elevation-2026-11-05.json (#94): the car's path with game world
// heights, from a shared-memory capture. Fetched on first use, like the Spa recording.
import type { ElevationTrack } from "../../lib/elevation";

export const SPA_ELEVATION_URL = "/mock/spa-elevation-2026-11-05.json";

export type ElevationLoader = () => Promise<ElevationTrack | null>;

let cached: Promise<ElevationTrack> | null = null;

/** Default browser loader: one fetch, cached for the page's lifetime (a failure is not cached). */
export const fetchSpaElevation: ElevationLoader = () => {
  if (!cached) {
    cached = fetch(SPA_ELEVATION_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`${SPA_ELEVATION_URL}: HTTP ${res.status}`);
        return res.json() as Promise<ElevationTrack>;
      })
      .catch((e) => {
        cached = null;
        throw e;
      });
  }
  return cached;
};
