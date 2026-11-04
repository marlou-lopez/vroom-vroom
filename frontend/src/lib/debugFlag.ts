/**
 * Debug controls (HUD, benchmark, line-source selector, GPU context-loss test) of the detailed track view.
 * `?debug` / `?debug=1` turns them on in any build, `?debug=0` / `?debug=false` turns them off (also in dev, to
 * preview the production view); without the parameter they follow the build (on in `npm run dev`).
 */
export function debugEnabled(isDev: boolean, search: string): boolean {
  const v = new URLSearchParams(search).get("debug");
  if (v === null) return isDev;
  return v !== "0" && v !== "false";
}
