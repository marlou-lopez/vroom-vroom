// The Spa edges and kerbs extracted from open aerial imagery (vroom-ueg.8, tools/aerial-edges), served at
// /mock/spa-aerial-2023.json. Vectors only: no imagery is in the file. Fetched on first use, like the survey.
import type { AerialFile } from "../../lib/aerialEdges";

export const SPA_AERIAL_URL = "/mock/spa-aerial-2023.json";

export type AerialLoader = () => Promise<AerialFile | null>;

let cached: Promise<AerialFile> | null = null;

/** Default browser loader: one fetch, cached for the page's lifetime (a failure is not cached). */
export const fetchSpaAerial: AerialLoader = () => {
  if (!cached) {
    cached = fetch(SPA_AERIAL_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`${SPA_AERIAL_URL}: HTTP ${res.status}`);
        return res.json() as Promise<AerialFile>;
      })
      .catch((e) => {
        cached = null;
        throw e;
      });
  }
  return cached;
};
