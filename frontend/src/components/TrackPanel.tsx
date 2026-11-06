import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { Fragment, useState, type ReactNode } from "react";
import type { TrackMap } from "../api/types";
import type { Annotation } from "../lib/annotations";
import type { PlaybackModel } from "../lib/model";
import { distanceAtTime, indexAtTime } from "../lib/playback";
import { formatDelta, gearLabel } from "../lib/format";
import { cx } from "../lib/cx";
import { cornerAt } from "../lib/trackmap";
import { usePlayback } from "../state/playback";
import { loadTrackView, saveTrackView } from "../state/mapViewPref";
import type { BadgeHandlers } from "./AnnotationOverlays";
import { TRACK_VIEWS } from "./mapviews/registry";
import type { TrackViewId } from "./mapviews/types";
import ui from "./ui.module.css";
import styles from "./TrackPanel.module.css";

export interface TrackPanelProps {
  model: PlaybackModel;
  trackMap: TrackMap | null;
  annotations: Annotation[];
  handlers: BadgeHandlers;
  lapTimes?: { lap: number | null; ref: number | null };
  /** Bottom strip of the panel (EngineerLine). */
  footer?: ReactNode;
  expanded: boolean;
  onToggleExpanded(): void;
}

export function TrackPanel({ model, trackMap, annotations, handlers, lapTimes, footer, expanded, onToggleExpanded }: TrackPanelProps) {
  const [viewId, setViewId] = useState<TrackViewId>(loadTrackView);

  const active = TRACK_VIEWS.find((v) => v.id === viewId) ?? TRACK_VIEWS[0];
  const View = active.Component;
  const selectView = (v: string) => {
    const next = TRACK_VIEWS.find((t) => t.id === v);
    if (!next) return;
    setViewId(next.id);
    saveTrackView(next.id);
  };

  return (
    <section aria-label="Track playback" className={styles.panel} data-expanded={expanded}>
      <View model={model} trackMap={trackMap} annotations={annotations} handlers={handlers} lapTimes={lapTimes} />
      <Readout model={model} trackMap={trackMap} />
      <div className={styles.toolbar}>
        <ToggleGroup.Root
          type="single" aria-label="Track view" className={styles.viewToggle}
          value={active.id} onValueChange={selectView}
        >
          {TRACK_VIEWS.map((v) => (
            <ToggleGroup.Item
              key={v.id} value={v.id} className={ui.toggleItem}
              title={v.experimental ? "Experimental" : undefined}
            >
              {v.label}
              {v.experimental && <span className={styles.exp}>exp</span>}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>
        <button
          type="button" className={cx(ui.btn, ui.btnMuted, styles.expand)}
          aria-pressed={expanded}
          aria-label={expanded ? "Collapse track view" : "Expand track view"}
          onClick={onToggleExpanded}
        >
          {expanded ? "⤡" : "⤢"}
        </button>
      </div>
      {footer && <div className={styles.footer}>{footer}</div>}
    </section>
  );
}

/** Corner, distance, gear, speed and delta read-out. The only part of the panel that follows the playhead, so the view above it stays still. */
function Readout({ model, trackMap }: { model: PlaybackModel; trackMap: TrackMap | null }) {
  const tau = usePlayback((s) => s.tau);
  const { cmp } = model;
  const iy = indexAtTime(cmp.lap.t, tau);
  const dYou = distanceAtTime(cmp.lap.t, cmp.distance, tau);
  const dRef = distanceAtTime(cmp.ref.t, cmp.distance, tau);
  const corner = trackMap ? cornerAt(trackMap, dYou) : null;
  const delta = cmp.delta[iy] ?? 0;
  const gap = Math.round(dRef - dYou);
  const gapLabel = gap > 0 ? `reference ${gap} m ahead` : gap < 0 ? `reference ${-gap} m behind` : "level with reference";
  return (
    <Fragment>
      <div className={styles.readout}>
        <div className={styles.corner}>{corner ? corner.name : "Straight"}</div>
        <div className={cx(styles.mono, styles.muted)}>
          {Math.round(dYou).toLocaleString("en-US")} m · gear {gearLabel(cmp.lap.gear[iy])} · {Math.round(cmp.lap.speed_kmh[iy])} km/h
        </div>
      </div>
      <div className={styles.deltaBox}>
        <div className={cx(styles.delta, delta > 0.005 && styles.loss, delta < -0.005 && styles.gain)}>{formatDelta(delta)} s</div>
        <div className={cx(styles.mono, styles.muted)}>{gapLabel}</div>
      </div>
    </Fragment>
  );
}
