import { createElement, type ComponentType } from "react";
import { ClassicMapView } from "./ClassicMapView";
import { DetailedMapView } from "./detailed/DetailedMapView";
import { PlaceholderView } from "./PlaceholderView";
import type { TrackViewId, TrackViewProps } from "./types";

export interface TrackViewDef {
  id: TrackViewId;
  label: string;
  experimental: boolean;
  Component: ComponentType<TrackViewProps>;
}

const View3d = () => createElement(PlaceholderView, { issue: 39 });

export const TRACK_VIEWS: readonly TrackViewDef[] = [
  { id: "2d", label: "2D", experimental: false, Component: ClassicMapView },
  { id: "2d-detailed", label: "2D detailed", experimental: false, Component: DetailedMapView },
  { id: "3d", label: "3D", experimental: true, Component: View3d },
];
