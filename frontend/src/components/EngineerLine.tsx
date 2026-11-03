import type { TrackMap } from "../api/types";
import type { Annotation } from "../lib/annotations";
import type { PlaybackModel } from "../lib/model";
import { distanceAtTime } from "../lib/playback";
import { cornerAt } from "../lib/trackmap";
import { usePlayback } from "../state/playback";
import styles from "./EngineerLine.module.css";

/** `ENGINEER  <corner>: <fix>` while your car is in a corner that has an issue or minor finding. */
export function EngineerLine({ annotations, trackMap, model }: { annotations: Annotation[]; trackMap: TrackMap | null; model: PlaybackModel }) {
  const tau = usePlayback((s) => s.tau);
  if (!trackMap || annotations.length === 0) return null;
  const corner = cornerAt(trackMap, distanceAtTime(model.cmp.lap.t, model.cmp.distance, tau));
  const a = corner && annotations.find((x) => x.cornerId === corner.id && (x.kind === "issue" || x.kind === "minor"));
  if (!a) return null;
  return (
    <div className={styles.line}>
      <span className={styles.tag}>ENGINEER</span>
      <span>{a.finding.corner}: {a.finding.fix}</span>
    </div>
  );
}
