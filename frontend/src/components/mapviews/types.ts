import type { TrackGeometry, TrackMap } from "../../api/types";
import type { PlaybackModel } from "../../lib/model";
import type { Annotation } from "../../lib/annotations";
import type { BadgeHandlers } from "../AnnotationOverlays";

export type TrackViewId = "2d" | "2d-detailed" | "3d";

export const TRACK_VIEW_IDS: readonly TrackViewId[] = ["2d", "2d-detailed", "3d"];

export interface TrackViewProps {
  model: PlaybackModel;
  trackMap: TrackMap | null;
  /** The track's elevation, edges and kerbs (`api.trackGeometry`, once per track). null while loading or when the track has none: the views then draw a flat track without edges. */
  geometry: TrackGeometry | null;
  annotations: Annotation[];
  handlers: BadgeHandlers;
  /** Recorded lap times (s) of the lap and the reference lap, for pane labels; absent or null falls back to the comparison grid's last time. */
  lapTimes?: { lap: number | null; ref: number | null };
}
