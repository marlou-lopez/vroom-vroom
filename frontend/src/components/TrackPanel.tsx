import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { TrackGeometry, TrackMap } from "../api/types";
import type { Annotation } from "../lib/annotations";
import type { PlaybackModel } from "../lib/model";
import { distanceAtTime, indexAtTime } from "../lib/playback";
import { formatDelta, gearLabel } from "../lib/format";
import { cx } from "../lib/cx";
import { standingLabel } from "../lib/compareName";
import { cornerAt, readoutCorner } from "../lib/trackmap";
import { CORNER_LEAD_M } from "../lib/annotations";
import { usePlayback } from "../state/playback";
import { loadTrackView, saveTrackView } from "../state/mapViewPref";
import type { BadgeHandlers } from "./AnnotationOverlays";
import { TRACK_VIEWS } from "./mapviews/registry";
import type { TrackViewId } from "./mapviews/types";
import { ErrorBoundary } from "./ErrorBoundary";
import ui from "./ui.module.css";
import styles from "./TrackPanel.module.css";

export interface TrackPanelProps {
  model: PlaybackModel;
  trackMap: TrackMap | null;
  geometry: TrackGeometry | null;
  annotations: Annotation[];
  handlers: BadgeHandlers;
  lapTimes?: { lap: number | null; ref: number | null };
  lapValid?: boolean;
  /** Short name of the comparison ("ideal", "reference", "L7"), so the read-out says who you are ahead of or behind. */
  refName?: string | null;
  /** Bottom strip of the panel (EngineerLine). */
  footer?: ReactNode;
  expanded: boolean;
  onToggleExpanded(): void;
}

export function TrackPanel({ model, trackMap, geometry, annotations, handlers, lapTimes, lapValid, refName, footer, expanded, onToggleExpanded }: TrackPanelProps) {
  const [viewId, setViewId] = useState<TrackViewId>(loadTrackView);

  const active = TRACK_VIEWS.find((v) => v.id === viewId) ?? TRACK_VIEWS[0];
  const View = active.Component;
  const selectView = (v: string) => {
    const next = TRACK_VIEWS.find((t) => t.id === v);
    if (!next) return;
    setViewId(next.id);
    saveTrackView(next.id);
  };

  // The view's own overlays (legend, camera and display bars) sit under this row, however many lines it wraps to.
  const panelRef = useRef<HTMLElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const panel = panelRef.current, top = topRef.current;
    if (!panel || !top || typeof ResizeObserver === "undefined") return;
    const set = () => panel.style.setProperty("--top-h", `${Math.ceil(top.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(top);
    return () => ro.disconnect();
  }, []);

  return (
    <section ref={panelRef} aria-label="Track playback" className={styles.panel} data-expanded={expanded}>
      <ErrorBoundary label="track view" variant="panel" resetKeys={[model, active.id]}>
        <View model={model} trackMap={trackMap} geometry={geometry} annotations={annotations} handlers={handlers} lapTimes={lapTimes} lapValid={lapValid} refName={refName ?? null} />
      </ErrorBoundary>
      <div ref={topRef} className={styles.top}>
      <Readout model={model} trackMap={trackMap} refName={refName ?? null} view={active.id} />
      <div className={styles.toolbar}>
        <ToggleGroup.Root
          type="single" aria-label="Track view" className={styles.viewToggle}
          value={active.id} onValueChange={selectView}
        >
          {TRACK_VIEWS.map((v) => (
            <ToggleGroup.Item
              key={v.id} value={v.id} className={ui.toggleItem}
              title={v.experimental ? "Beta: still being tested" : undefined}
            >
              {v.label}
              {v.experimental && <span className={styles.exp}>beta</span>}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>
        <button
          type="button" className={cx(ui.btn, ui.btnMuted, styles.expand)}
          aria-pressed={expanded}
          aria-label={expanded ? "Collapse track view" : "Expand track view"}
          title={expanded ? "Collapse track view" : "Expand track view"}
          onClick={onToggleExpanded}
        >
          {expanded ? "⤡" : "⤢"}
        </button>
      </div>
      </div>
      {footer && <div className={styles.footer}>{footer}</div>}
    </section>
  );
}

/** Corner, distance, gear, speed and delta read-out. The only part of the panel that follows the playhead, so the view above it stays still. */
function Readout({ model, trackMap, refName, view }: { model: PlaybackModel; trackMap: TrackMap | null; refName: string | null; view: string }) {
  const tau = usePlayback((s) => s.tau);
  const { cmp } = model;
  const iy = indexAtTime(cmp.lap.t, tau);
  const dYou = distanceAtTime(cmp.lap.t, cmp.distance, tau);
  const dRef = distanceAtTime(cmp.ref.t, cmp.distance, tau);
  const leadInId = usePlayback((s) => s.leadInCornerId);
  const named = trackMap ? readoutCorner(trackMap, dYou, leadInId, CORNER_LEAD_M) : null;
  const corner = trackMap ? cornerAt(trackMap, dYou) : null;
  const delta = cmp.delta[iy] ?? 0;
  const gap = Math.round(dRef - dYou);
  const understeer = corner !== null && (cmp.lap_understeer_runs ?? []).some((r) => dYou >= r.start_m && dYou <= r.end_m);
  const who = refName ?? "the comparison";
  const standing = standingLabel(delta, who);
  const gapLabel = gap > 0 ? `${who} ${gap} m ahead` : gap < 0 ? `${who} ${-gap} m behind` : standing ? null : `same pace as ${who}`;
    return (
    <Fragment>
      <div className={styles.readout} data-view={view}>
        <div className={styles.corner}>{named ? (named.approaching ? `Approaching ${named.corner.name}` : named.corner.name) : "Straight"}{understeer && <span className={styles.balance}>car pushing wide</span>}</div>
        <div className={cx(styles.mono, styles.muted)}>
          {Math.round(dYou).toLocaleString("en-US")} m · gear {gearLabel(cmp.lap.gear[iy])} · {Math.round(cmp.lap.speed_kmh[iy])} / {Math.round(cmp.ref.speed_kmh[indexAtTime(cmp.ref.t, tau)])} km/h
        </div>
      </div>
      <div className={styles.deltaBox} data-view={view}>
        <div className={cx(styles.delta, delta > 0.005 && styles.loss, delta < -0.005 && styles.gain)}>{formatDelta(delta)} s</div>
        {standing && <div className={cx(styles.mono, styles.muted)}>{standing}</div>}
        <div className={cx(styles.mono, styles.muted)}>{gapLabel}</div>
      </div>
    </Fragment>
  );
}
