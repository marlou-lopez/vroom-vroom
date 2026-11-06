import { memo, type ComponentType } from "react";
import { ClassicMapView } from "./ClassicMapView";
import { DetailedMapView } from "./detailed/DetailedMapView";
import { RibbonView } from "./ribbon/RibbonView";
import type { TrackViewId, TrackViewProps } from "./types";

export interface TrackViewDef {
  id: TrackViewId;
  label: string;
  experimental: boolean;
  Component: ComponentType<TrackViewProps>;
}

export const TRACK_VIEWS: readonly TrackViewDef[] = [
  { id: "2d", label: "2D", experimental: false, Component: memo(ClassicMapView) },
  { id: "2d-detailed", label: "2D detailed", experimental: false, Component: memo(DetailedMapView) },
  { id: "3d", label: "3D", experimental: true, Component: memo(RibbonView) },
];
