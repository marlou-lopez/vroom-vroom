import type { Annotation } from "./annotations";

export const isAdvice = (a: Annotation) => a.kind === "issue" || a.kind === "minor";

/** The nearest issue or minor finding whose corner starts ahead of distance `d` (no wrap-around), or null. */
export function nextFinding(annotations: Annotation[], d: number): Annotation | null {
  let best: Annotation | null = null;
  for (const a of annotations) {
    if (isAdvice(a) && a.startM > d && (best === null || a.startM < best.startM)) best = a;
  }
  return best;
}
