import type { TrackMap } from "../api/types";
import type { Annotation } from "../lib/annotations";
import type { PlaybackModel } from "../lib/model";
import { distanceAtTime } from "../lib/playback";
import { isAdvice, nextFinding } from "../lib/nextFinding";
import { cornerAt } from "../lib/trackmap";
import { usePlayback } from "../state/playback";
import styles from "./EngineerLine.module.css";

/**
 * `ENGINEER  <corner>: <fix>` while your car is in a corner that has an issue or minor finding. While paused and
 * not in such a corner, `ENGINEER  Next: <corner>: <fix>` shows the next finding ahead.
 */
export function EngineerLine({ annotations, trackMap, model }: { annotations: Annotation[]; trackMap: TrackMap | null; model: PlaybackModel }) {
  const tau = usePlayback((s) => s.tau);
  const playing = usePlayback((s) => s.playing);
  if (!trackMap || annotations.length === 0) return null;
  const d = distanceAtTime(model.cmp.lap.t, model.cmp.distance, tau);
  const corner = cornerAt(trackMap, d);
  const here = corner && annotations.find((x) => x.cornerId === corner.id && isAdvice(x));
  const a = here || (playing ? null : nextFinding(annotations, d));
  if (!a) return null;
  return (
    <div className={styles.line}>
      <span className={styles.tag}>ENGINEER</span>
      <span>{!here && "Next: "}{a.finding.corner}: {a.finding.fix}</span>
    </div>
  );
}
