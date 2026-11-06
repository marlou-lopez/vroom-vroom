import type { TrackMap } from "../../api/types";
import type { PlaybackModel } from "../../lib/model";
import type { Annotation } from "../../lib/annotations";
import type { BadgeHandlers } from "../AnnotationOverlays";

export type TrackViewId = "2d" | "2d-detailed" | "3d";

export const TRACK_VIEW_IDS: readonly TrackViewId[] = ["2d", "2d-detailed", "3d"];

export interface TrackViewProps {
  model: PlaybackModel;
  trackMap: TrackMap | null;
  annotations: Annotation[];
  handlers: BadgeHandlers;
  /** Recorded lap times (s) of the lap and the reference lap, for pane labels; absent or null falls back to the comparison grid's last time. */
  lapTimes?: { lap: number | null; ref: number | null };
}
