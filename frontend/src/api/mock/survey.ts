// The Spa track survey served at /mock/spa-survey-2026-11-06.json (#97): track edges and kerbs from shared-memory
// captures (tools/lmu-logger/decode.py survey). Fetched on first use, like the elevation capture.
import type { SurveyFile } from "../../lib/trackSurvey";

export const SPA_SURVEY_URL = "/mock/spa-survey-2026-11-06.json";

export type SurveyLoader = () => Promise<SurveyFile | null>;

let cached: Promise<SurveyFile> | null = null;

/** Default browser loader: one fetch, cached for the page's lifetime (a failure is not cached). */
export const fetchSpaSurvey: SurveyLoader = () => {
  if (!cached) {
    cached = fetch(SPA_SURVEY_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`${SPA_SURVEY_URL}: HTTP ${res.status}`);
        return res.json() as Promise<SurveyFile>;
      })
      .catch((e) => {
        cached = null;
        throw e;
      });
  }
  return cached;
};
