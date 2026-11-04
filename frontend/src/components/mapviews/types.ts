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
}
